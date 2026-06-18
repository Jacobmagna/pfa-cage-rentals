// Internal hour-log mutation logic. Lives outside any "use server"
// file because Next.js exposes every async export from "use server"
// files as a public RPC endpoint — and this function takes the actor
// as a parameter, so exposing it would let anyone forge an admin
// identity.
//
// The public coach-side server action in
// src/app/coach/hour-log/actions.ts wraps this with requireSession().
//
// Pipeline (mirrors createSessionInternal):
//   1. Zod-parse                        — createHourLogSchema
//   2. Program lookup + active check    — business invariant. Any coach
//      may log against any active program (DEC-29), so there's no
//      per-coach program-access gate here.
//   3. Insert, then audit (sequential)  — see "Atomicity" below
//
// Atomicity: neon-http is stateless HTTP and does NOT support
// transactions. We insert first, then log the audit row as a
// separate statement (via safeLogAudit, which swallows + Sentry-
// captures audit failures so a logging hiccup never loses a logged
// hour). Same shape as the session create path.

import { and, desc, eq, gte, lt } from "drizzle-orm";
import { db } from "@/db";
import {
  coachPaySettings,
  hourLogs,
  programRateOverrides,
  programScheduleBlockCoaches,
  programScheduleBlocks,
  programs,
  users,
} from "@/db/schema";
import { type AuthedSession } from "@/lib/authz";
import { rateForProgram } from "@/lib/billing";
import {
  HeldHourLogNotFoundError,
  HeldLogReviewRequiredError,
  HourLogNotFoundError,
  ProgramInactiveError,
  ProgramNotFoundError,
  RejectReasonRequiredError,
} from "@/lib/errors";
import {
  createHourLogSchema,
  editHourLogSchema,
} from "@/lib/schemas/hour-log";
import {
  classifyManualLog,
  type ReconBlock,
} from "@/lib/server/reconciliation";
import { formatPfaTime12h } from "@/lib/timezone";
import { safeLogAudit } from "./audit-helpers";

// Resolves the per-30-min cents pay rate to stamp on a new hour_logs
// row. Reads the (coach, program) override from program_rate_overrides,
// then delegates to billing.rateForProgram, falling back to the
// program's default_rate_per_30_min_cents and finally null (no rate
// set → $0 pay). Mirrors resolveRateCents in session-actions.ts.
export async function resolveRateCentsForProgram(args: {
  coachId: string;
  programId: string;
  programDefaultCents: number | null;
}): Promise<number | null> {
  const [override] = await db
    .select()
    .from(programRateOverrides)
    .where(
      and(
        eq(programRateOverrides.coachId, args.coachId),
        eq(programRateOverrides.programId, args.programId),
      ),
    );
  return rateForProgram(
    args.programId,
    args.coachId,
    override
      ? [
          {
            coachId: override.coachId,
            programId: override.programId,
            ratePer30MinCents: override.ratePer30MinCents,
          },
        ]
      : [],
    args.programDefaultCents,
  );
}

// QA2 #6 — resolves the per-session pay snapshot (cents) to stamp on a new
// hour_logs row. Returns the coach's coachPaySettings.perSessionRateCents ONLY
// when the coach is on the "per_session" pay mode AND has a positive rate set;
// otherwise null (every hourly coach, every coach with no settings row, and any
// per_session coach with a missing/non-positive rate → hourly snapshot applies).
// Preserves the immutable-snapshot rule: changing a coach's mode never re-bills.
export async function resolvePerSessionRateCents(
  coachId: string,
): Promise<number | null> {
  const [settings] = await db
    .select()
    .from(coachPaySettings)
    .where(eq(coachPaySettings.coachId, coachId))
    .limit(1);
  if (
    settings?.payMode === "per_session" &&
    typeof settings.perSessionRateCents === "number" &&
    Number.isInteger(settings.perSessionRateCents) &&
    settings.perSessionRateCents > 0
  ) {
    return settings.perSessionRateCents;
  }
  return null;
}

export async function logHourInternal(
  actor: AuthedSession["user"],
  input: unknown,
) {
  const parsed = createHourLogSchema.parse(input);

  const [program] = await db
    .select()
    .from(programs)
    .where(eq(programs.id, parsed.programId))
    .limit(1);
  if (!program) throw new ProgramNotFoundError(parsed.programId);
  if (!program.active) {
    throw new ProgramInactiveError(program.id, program.name);
  }

  // Stamp the resolved pay rate as a snapshot (cents per 30-min slot),
  // mirroring sessions_billing. May be null when the program has no
  // rate set → $0 pay; reads treat null as 0.
  const ratePer30MinCents = await resolveRateCentsForProgram({
    coachId: actor.id,
    programId: parsed.programId,
    programDefaultCents: program.defaultRatePer30MinCents,
  });

  // QA2 #6 — per-session pay snapshot. Non-null only when the coach is on the
  // "per_session" pay mode with a positive rate; otherwise null = hourly basis
  // (the ratePer30MinCents snapshot above applies). Snapshotted alongside the
  // hourly rate so a later mode change never re-bills this log. Applies to ALL
  // insert paths (coach self-log, schedule-confirm auto-confirm, held).
  const perSessionRateCents = await resolvePerSessionRateCents(actor.id);

  // 1b security B — held-then-approve gate. Runs for EVERY source. The
  // `source` flag (client-supplied) must NOT be able to bypass this check:
  // a forged source:"schedule-confirm" with no matching block would
  // otherwise post immediately as payable (P0 payroll-fraud). Instead we
  // ALWAYS fetch the actor's scheduled MEMBER blocks overlapping the log
  // window (same join as the coach history page) and classify the log.
  // A clean log posts as today — this is exactly what the trusted
  // auto-confirm hotlink sends (the block's EXACT start/end/program), so it
  // still posts instantly. An anomalous log is either held (coach
  // acknowledged) or refused with a thrown error the form turns into a
  // "send for approval / go back and edit" warning.
  let heldReason: "unscheduled" | "wrong_time" | "over_logged" | null = null;
  {
    const blockRows = await db
      .select({
        id: programScheduleBlocks.id,
        programId: programScheduleBlocks.programId,
        startAt: programScheduleBlocks.startAt,
        endAt: programScheduleBlocks.endAt,
      })
      .from(programScheduleBlocks)
      .innerJoin(
        programScheduleBlockCoaches,
        eq(programScheduleBlockCoaches.blockId, programScheduleBlocks.id),
      )
      .where(
        and(
          eq(programScheduleBlockCoaches.coachId, actor.id),
          // Half-open overlap with the log window.
          lt(programScheduleBlocks.startAt, parsed.endAt),
          gte(programScheduleBlocks.endAt, parsed.startAt),
        ),
      );
    // ReconBlock[] — all blocks are the actor's own (coachId = actor.id),
    // so the in-set checks inside the classifier are satisfied implicitly.
    // Names are unused by classifyManualLog, so pass "".
    const blocks: ReconBlock[] = blockRows.map((b) => ({
      id: b.id,
      programId: b.programId,
      scheduledCoachId: actor.id,
      scheduledCoachName: "",
      coaches: [{ coachId: actor.id, coachName: "" }],
      startAt: b.startAt,
      endAt: b.endAt,
    }));

    const anomaly = classifyManualLog(
      {
        coachId: actor.id,
        programId: parsed.programId,
        startAt: parsed.startAt,
        endAt: parsed.endAt,
      },
      blocks,
      formatPfaTime12h,
    );

    if (anomaly.kind !== "clean") {
      if (parsed.acknowledgeHold !== true) {
        // No write — the coach must explicitly send it for approval.
        throw new HeldLogReviewRequiredError(anomaly.kind, anomaly.message);
      }
      heldReason = anomaly.kind;
    }
  }

  // Idempotent insert: the hour_logs_coach_program_start_end_unique index
  // (mig 0029) makes an exact (coach, program, start, end) a true duplicate.
  // onConflictDoNothing means a double-confirm/double-tap (or a race between
  // two tabs/devices) never writes a second paid row — the second attempt
  // returns an EMPTY array, which we treat as a graceful no-op by returning
  // the already-logged row (no error, no duplicate audit entry).
  const [inserted] = await db
    .insert(hourLogs)
    .values({
      coachId: actor.id,
      programId: parsed.programId,
      startAt: parsed.startAt,
      endAt: parsed.endAt,
      note: parsed.note ?? null,
      ratePer30MinCents,
      perSessionRateCents,
      createdBy: actor.id,
      // A clean/auto-confirm log omits status → relies on the "posted"
      // default. Only the held branch stamps status + heldReason.
      ...(heldReason !== null
        ? { status: "held" as const, heldReason }
        : {}),
    })
    .onConflictDoNothing({
      target: [
        hourLogs.coachId,
        hourLogs.programId,
        hourLogs.startAt,
        hourLogs.endAt,
      ],
    })
    .returning();

  if (!inserted) {
    // Conflict: an identical log already exists. The unique index does NOT
    // include `status`, so a held row + a later CLEAN confirm of the exact
    // same window both collide here.
    const [existing] = await db
      .select()
      .from(hourLogs)
      .where(
        and(
          eq(hourLogs.coachId, actor.id),
          eq(hourLogs.programId, parsed.programId),
          eq(hourLogs.startAt, parsed.startAt),
          eq(hourLogs.endAt, parsed.endAt),
        ),
      )
      .limit(1);

    // Held → posted auto-upgrade: if the existing row is stuck "held"
    // (awaiting admin approval, unpaid, excluded from counts) AND the
    // current attempt is itself CLEAN (heldReason === null → it matched a
    // scheduled block cleanly), treat this confirm as the approval. We
    // mirror approveHeldHourLogInternal exactly: flip status → "posted" and
    // stamp reviewedAt/reviewedBy so the row also leaves the needs-review
    // queue, plus clear the stale heldReason. We do NOT downgrade an
    // already-"posted" row, and we never auto-approve when the current
    // attempt is itself anomalous (heldReason !== null) — that stays held.
    if (existing && existing.status === "held" && heldReason === null) {
      const [upgraded] = await db
        .update(hourLogs)
        .set({
          status: "posted",
          heldReason: null,
          reviewedAt: new Date(),
          reviewedBy: actor.id,
        })
        .where(eq(hourLogs.id, existing.id))
        .returning();

      await safeLogAudit(db, {
        actorUserId: actor.id,
        entityType: "hour_log",
        entityId: existing.id,
        action: "update",
        before: existing as unknown as Record<string, unknown>,
        after: upgraded as unknown as Record<string, unknown>,
      });
      return upgraded;
    }

    // Otherwise an identical log already exists in its current state
    // (already posted, or still legitimately held by an anomalous attempt).
    // Return it unchanged without writing a duplicate audit row.
    return existing;
  }

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "hour_log",
    entityId: inserted.id,
    action: "create",
    after: inserted as unknown as Record<string, unknown>,
  });
  return inserted;
}

// Admin-only edit of an existing hour-log row. Mirrors
// updateSessionInternal: fetch the existing row, Zod-parse the desired
// state, persist, then audit a changed-keys-only diff (before/after).
//
// The admin edit surface only changes times/note (the row stays bound
// to its original program), so we do NOT re-run the active-program
// check here — that guards the CREATE path where a coach picks a
// program. editHourLogSchema still validates endAt > startAt (DB CHECK
// is canonical; this gives a friendly error).
export async function updateHourInternal(
  actor: AuthedSession["user"],
  id: string,
  input: unknown,
) {
  const [existing] = await db
    .select()
    .from(hourLogs)
    .where(eq(hourLogs.id, id))
    .limit(1);
  if (!existing) throw new HourLogNotFoundError(id);

  const parsed = editHourLogSchema.parse(input);

  const [updated] = await db
    .update(hourLogs)
    .set({
      programId: parsed.programId,
      startAt: parsed.startAt,
      endAt: parsed.endAt,
      note: parsed.note ?? null,
    })
    .where(eq(hourLogs.id, id))
    .returning();

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "hour_log",
    entityId: id,
    action: "update",
    before: existing as unknown as Record<string, unknown>,
    after: updated as unknown as Record<string, unknown>,
  });
  return updated;
}

// Admin-only hard delete of an hour-log row. hour_logs has no
// soft-delete column — it's a simple log entry — so we DELETE outright
// and capture the full `before` snapshot in the audit row. Mirrors
// deleteSessionInternal.
export async function deleteHourInternal(
  actor: AuthedSession["user"],
  id: string,
) {
  const [existing] = await db
    .select()
    .from(hourLogs)
    .where(eq(hourLogs.id, id))
    .limit(1);
  if (!existing) throw new HourLogNotFoundError(id);

  await db.delete(hourLogs).where(eq(hourLogs.id, id));
  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "hour_log",
    entityId: id,
    action: "delete",
    before: existing as unknown as Record<string, unknown>,
  });
}

// Admin-only "Resolve" — mark an unscheduled hour-log reviewed/acknowledged.
// The row STAYS (real worked time/pay); stamping reviewedAt just drops it off
// the needs-review queue. Idempotent: if the row is already reviewed we keep
// the original reviewer/timestamp and return it unchanged (never overwrite).
// We deliberately do NOT verify the row is actually unscheduled — stamping a
// scheduled row is harmless (it simply never surfaces a Resolve button).
export async function resolveHourLogInternal(
  actor: AuthedSession["user"],
  id: string,
) {
  const [existing] = await db
    .select()
    .from(hourLogs)
    .where(eq(hourLogs.id, id))
    .limit(1);
  if (!existing) throw new HourLogNotFoundError(id);

  // Idempotent — already reviewed, keep the original reviewer.
  if (existing.reviewedAt) return existing;

  const [updated] = await db
    .update(hourLogs)
    .set({ reviewedAt: new Date(), reviewedBy: actor.id })
    .where(eq(hourLogs.id, id))
    .returning();

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "hour_log",
    entityId: id,
    action: "update",
    before: existing as unknown as Record<string, unknown>,
    after: updated as unknown as Record<string, unknown>,
  });
  return updated;
}

// 1b security B — admin APPROVE of a held manual log. Flips status to
// "posted" so it becomes payable + counted everywhere. We also stamp
// reviewedAt/reviewedBy so an approved formerly-unscheduled log ALSO leaves
// the needs-review queue (same marker resolveHourLogInternal uses). Throws
// HeldHourLogNotFoundError if the row is missing or no longer held (another
// tab already resolved it).
export async function approveHeldHourLogInternal(
  actor: AuthedSession["user"],
  id: string,
) {
  const [existing] = await db
    .select()
    .from(hourLogs)
    .where(eq(hourLogs.id, id))
    .limit(1);
  if (!existing || existing.status !== "held") {
    throw new HeldHourLogNotFoundError(id);
  }

  const [updated] = await db
    .update(hourLogs)
    .set({ status: "posted", reviewedAt: new Date(), reviewedBy: actor.id })
    .where(eq(hourLogs.id, id))
    .returning();

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "hour_log",
    entityId: id,
    action: "update",
    before: existing as unknown as Record<string, unknown>,
    after: updated as unknown as Record<string, unknown>,
  });
  return updated;
}

// 1b security B — admin REJECT of a held manual log. DELETEs the row (the
// coach must re-enter corrected data — there's no lingering rejected state)
// and captures the full `before` snapshot in the audit row, threading the
// optional admin note into the audit `after` payload. Throws
// HeldHourLogNotFoundError if the row is missing or no longer held.
export async function rejectHeldHourLogInternal(
  actor: AuthedSession["user"],
  id: string,
  adminNote?: string,
) {
  const [existing] = await db
    .select()
    .from(hourLogs)
    .where(eq(hourLogs.id, id))
    .limit(1);
  if (!existing || existing.status !== "held") {
    throw new HeldHourLogNotFoundError(id);
  }

  await db.delete(hourLogs).where(eq(hourLogs.id, id));
  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "hour_log",
    entityId: id,
    action: "delete",
    before: existing as unknown as Record<string, unknown>,
    ...(adminNote ? { after: { adminNote } } : {}),
  });
}

// Admin ACCEPTS a needs-review hour log: it stays posted (counts) and is
// marked reviewed. Idempotent. Mirrors resolveHourLogInternal but is the
// explicit "accepted" decision the coach is notified of.
export async function acceptNeedsReviewLogInternal(
  actor: AuthedSession["user"],
  id: string,
) {
  const [existing] = await db
    .select()
    .from(hourLogs)
    .where(eq(hourLogs.id, id))
    .limit(1);
  if (!existing) throw new HourLogNotFoundError(id);

  // Idempotent — already accepted (posted + reviewed), keep the original
  // reviewer/timestamp and return unchanged.
  if (existing.status === "posted" && existing.reviewedAt) return existing;

  const [updated] = await db
    .update(hourLogs)
    .set({ reviewedAt: new Date(), reviewedBy: actor.id })
    .where(eq(hourLogs.id, id))
    .returning();

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "hour_log",
    entityId: id,
    action: "update",
    before: existing as unknown as Record<string, unknown>,
    after: updated as unknown as Record<string, unknown>,
  });
  return updated;
}

// Admin REJECTS a needs-review hour log: it is NOT deleted (the coach must
// still see it + the reason) but flips to status 'rejected' so it is excluded
// from every pay/report/needs-review/accountability read (all of which pin
// status='posted'). Idempotent.
export async function rejectNeedsReviewLogInternal(
  actor: AuthedSession["user"],
  id: string,
  reason: string,
) {
  const trimmed = reason.trim();
  if (!trimmed) throw new RejectReasonRequiredError();

  const [existing] = await db
    .select()
    .from(hourLogs)
    .where(eq(hourLogs.id, id))
    .limit(1);
  if (!existing) throw new HourLogNotFoundError(id);

  // Idempotent — already rejected: keep the original reason/reviewer.
  if (existing.status === "rejected") return existing;

  const [updated] = await db
    .update(hourLogs)
    .set({
      status: "rejected",
      reviewedAt: new Date(),
      reviewedBy: actor.id,
      decisionReason: trimmed,
    })
    .where(eq(hourLogs.id, id))
    .returning();

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "hour_log",
    entityId: id,
    action: "update",
    before: existing as unknown as Record<string, unknown>,
    after: {
      ...(updated as unknown as Record<string, unknown>),
      reason: trimmed,
    },
  });
  return updated;
}

// 1b security B — the admin held-approval queue, newest-first by createdAt.
// Joins the coach name (users) + program name (programs). Returns only the
// fields the queue UI renders.
export async function loadHeldHourLogs(): Promise<
  {
    id: string;
    coachName: string | null;
    programName: string;
    programId: string;
    startAt: Date;
    endAt: Date;
    heldReason: string | null;
    note: string | null;
    createdAt: Date;
  }[]
> {
  return db
    .select({
      id: hourLogs.id,
      coachName: users.name,
      programName: programs.name,
      programId: hourLogs.programId,
      startAt: hourLogs.startAt,
      endAt: hourLogs.endAt,
      heldReason: hourLogs.heldReason,
      note: hourLogs.note,
      createdAt: hourLogs.createdAt,
    })
    .from(hourLogs)
    .innerJoin(users, eq(hourLogs.coachId, users.id))
    .innerJoin(programs, eq(hourLogs.programId, programs.id))
    .where(eq(hourLogs.status, "held"))
    .orderBy(desc(hourLogs.createdAt));
}

// 1b security B — held-count for the Work Log entry-point badge.
export async function countHeldHourLogs(): Promise<number> {
  const rows = await db
    .select({ id: hourLogs.id })
    .from(hourLogs)
    .where(eq(hourLogs.status, "held"));
  return rows.length;
}
