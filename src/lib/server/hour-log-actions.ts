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
  hourLogs,
  programRateOverrides,
  programScheduleBlockCoaches,
  programScheduleBlocks,
  programs,
  users,
} from "@/db/schema";
import { type AuthedSession } from "@/lib/authz";
import { workPayForLog } from "@/lib/billing";
import {
  DuplicateHourLogError,
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
  matchLogToBlock,
  type ReconBlock,
} from "@/lib/server/reconciliation";
import { formatPfaTime12h } from "@/lib/timezone";
import { safeLogAudit } from "./audit-helpers";

// DESIGN-1: the (coach, program) pay mode + rates now live on a SINGLE
// program_rate_overrides row, fetched ONCE per log (in logHourInternal)
// and threaded into both pure resolvers below. The row's `payMode`
// decides which snapshot applies. Both resolvers are pure (no DB) so the
// branch space is unit-testable without mocks. `ProgramRateOverrideRow`
// is the inferred SELECT shape of the override row (null = no override).
type ProgramRateOverrideRow = typeof programRateOverrides.$inferSelect;

// The pay-relevant slice of a `programs` row. Taking the three fields (not
// just the hourly default, as before migration 0052) is what lets a PROGRAM
// carry a per-session rate instead of only a per-(coach, program) override.
// Callers pass the whole slice so the two resolvers can never disagree about
// which mode the program is in.
export type ProgramPayConfig = Pick<
  typeof programs.$inferSelect,
  "payMode" | "defaultRatePer30MinCents" | "defaultPerSessionRateCents"
>;

/** A usable money amount: a positive whole number of cents. */
function isPositiveCents(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

// Resolves the per-30-min cents HOURLY pay rate to stamp on a new
// hour_logs row, from the already-fetched (coach, program) override row.
// When the override is on "hourly" mode with a rate set, that rate wins;
// otherwise we fall back to the program's default_rate_per_30_min_cents
// (which may itself be null → $0 pay until an admin sets one). A
// per_session override has a null hourly rate and so also falls through
// to the program default here — harmless, since the per-session snapshot
// (below) is what the read path uses for those logs.
export function resolveRateCentsForProgram(
  override: ProgramRateOverrideRow | undefined | null,
  program: ProgramPayConfig | null,
): number | null {
  if (
    override &&
    override.payMode === "hourly" &&
    override.ratePer30MinCents != null
  ) {
    return override.ratePer30MinCents;
  }
  // A per_session PROGRAM has no hourly basis of its own — the flat amount
  // stamped by resolvePerSessionRateCents is the whole pay. Returning the
  // program's (possibly stale) hourly default here would leave a misleading
  // snapshot on the row.
  //
  // NOTE this branch is unreachable for every program that existed before
  // migration 0052: they all backfill to payMode="hourly", so the line below
  // is the ONLY one that runs for them — behavior is byte-identical until an
  // admin deliberately flips a program to per-session.
  if (program?.payMode === "per_session") {
    return null;
  }
  return program?.defaultRatePer30MinCents ?? null;
}

// DESIGN-1 — resolves the per-session pay snapshot (cents) to stamp on a new
// hour_logs row, from the same already-fetched (coach, program) override row.
// Returns the override's perSessionRateCents ONLY when that override is on the
// "per_session" pay mode with a positive integer amount; otherwise null (every
// hourly override, every (coach, program) pair with no override row, and any
// per_session override with a missing/non-positive amount → the hourly
// ratePer30MinCents snapshot applies instead). Preserves the immutable-snapshot
// rule: changing a coach's per-program mode never re-rates existing logs.
export function resolvePerSessionRateCents(
  override: ProgramRateOverrideRow | undefined | null,
  program: ProgramPayConfig | null,
): number | null {
  // A (coach, program) override WINS OUTRIGHT — including an HOURLY one,
  // which returns null here on purpose so that coach is paid hourly even on
  // a per-session program. Coach-specific always beats the program default,
  // consistent with how every other rate in this system resolves.
  // ⚠️ Operational consequence: flipping a program to per-session does NOT
  // reach coaches who hold an hourly override on it — those overrides must be
  // deleted, or they keep being paid by the clock. The Work tab warns about
  // this; see the per-session banner in program-form-dialog.
  if (override) {
    if (
      override.payMode === "per_session" &&
      isPositiveCents(override.perSessionRateCents)
    ) {
      return override.perSessionRateCents;
    }
    return null;
  }
  // No override → the PROGRAM's pay mode decides. This is the branch that
  // fixes "HS Summer Travel - Game": a flat fee per game logged, regardless
  // of how many hours the game ran.
  if (
    program?.payMode === "per_session" &&
    isPositiveCents(program.defaultPerSessionRateCents)
  ) {
    return program.defaultPerSessionRateCents;
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

  // DESIGN-1: fetch the (coach, program) override row ONCE — its payMode
  // decides BOTH pay snapshots below. Per-program now, not coach-wide.
  const [override] = await db
    .select()
    .from(programRateOverrides)
    .where(
      and(
        eq(programRateOverrides.coachId, actor.id),
        eq(programRateOverrides.programId, parsed.programId),
      ),
    )
    .limit(1);

  // Stamp the resolved HOURLY pay rate as a snapshot (cents per 30-min
  // slot), mirroring sessions_billing. May be null when neither the
  // override nor the program sets a rate → $0 pay; reads treat null as 0.
  const ratePer30MinCents = resolveRateCentsForProgram(override, program);

  // DESIGN-1 — per-session pay snapshot. Non-null only when this
  // (coach, program) override is on the "per_session" pay mode with a
  // positive amount; otherwise null = hourly basis (the ratePer30MinCents
  // snapshot above applies). Snapshotted alongside the hourly rate so a
  // later mode change never re-rates this log. Applies to ALL insert paths
  // (coach self-log, schedule-confirm auto-confirm, held).
  const perSessionRateCents = resolvePerSessionRateCents(override, program);

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
  edit?: { startAt: Date; endAt: Date },
) {
  const [existing] = await db
    .select()
    .from(hourLogs)
    .where(eq(hourLogs.id, id))
    .limit(1);
  if (!existing || existing.status !== "held") {
    throw new HeldHourLogNotFoundError(id);
  }

  let updated;
  try {
    [updated] = await db
      .update(hourLogs)
      .set({
        status: "posted",
        reviewedAt: new Date(),
        reviewedBy: actor.id,
        ...(edit ? { startAt: edit.startAt, endAt: edit.endAt } : {}),
      })
      // Guard the WRITE on status='held' too (not just the SELECT above):
      // neon-http can't transact, so another tab resolving this row between
      // our SELECT and UPDATE would otherwise slip through. If it already
      // moved, the update matches 0 rows and we treat it as already-resolved.
      .where(and(eq(hourLogs.id, id), eq(hourLogs.status, "held")))
      .returning();
  } catch (err) {
    if (edit && isHourLogDuplicateViolation(err)) {
      throw new DuplicateHourLogError();
    }
    throw err;
  }
  if (!updated) throw new HeldHourLogNotFoundError(id);

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

// Postgres SQLSTATE 23505 — unique_violation, specifically the
// hour_logs_coach_program_start_end_unique index. Neon's HTTP driver wraps
// errors, so we walk the cause chain (same shape as program-actions'
// isProgramNameViolation). We additionally match the constraint name so a
// future second unique constraint on hour_logs wouldn't get mistranslated.
function isHourLogDuplicateViolation(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err) {
    const e = err as { code?: unknown; constraint?: unknown };
    if (e.code === "23505") {
      if (
        e.constraint === undefined ||
        e.constraint === "hour_logs_coach_program_start_end_unique"
      ) {
        return true;
      }
    }
  }
  if (err instanceof Error && err.cause) {
    return isHourLogDuplicateViolation(err.cause);
  }
  return false;
}

// Admin ACCEPTS a needs-review hour log: it stays posted (counts) and is
// marked reviewed. Idempotent. Mirrors resolveHourLogInternal but is the
// explicit "accepted" decision the coach is notified of.
//
// Optional `edit` lets the admin CORRECT the log's start/end times in the
// same action (e.g. a coach logged a 30-min-off time). Pay/hours are computed
// downstream from start/end × the snapshotted rate, so updating the times
// auto-corrects the money — we never touch the rate/snapshot, no migration.
// When `edit` is present we ALWAYS apply it (no idempotent short-circuit — the
// admin may be correcting times on an already-reviewed log); the audit diff
// captures the time change. Shifting onto an exact (coach, program, start, end)
// duplicate is caught (23505) and re-thrown as a friendly DuplicateHourLogError.
export async function acceptNeedsReviewLogInternal(
  actor: AuthedSession["user"],
  id: string,
  edit?: { startAt: Date; endAt: Date },
) {
  const [existing] = await db
    .select()
    .from(hourLogs)
    .where(eq(hourLogs.id, id))
    .limit(1);
  if (!existing) throw new HourLogNotFoundError(id);

  // Idempotent — already accepted (posted + reviewed), keep the original
  // reviewer/timestamp and return unchanged. Skipped when an edit is present:
  // the admin may be correcting times even on an already-reviewed log.
  if (!edit && existing.status === "posted" && existing.reviewedAt) {
    return existing;
  }

  let updated;
  try {
    [updated] = await db
      .update(hourLogs)
      .set({
        ...(edit ? { startAt: edit.startAt, endAt: edit.endAt } : {}),
        reviewedAt: new Date(),
        reviewedBy: actor.id,
      })
      .where(eq(hourLogs.id, id))
      .returning();
  } catch (err) {
    if (edit && isHourLogDuplicateViolation(err)) {
      throw new DuplicateHourLogError();
    }
    throw err;
  }

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

// 1b security B — read-only detail for the admin held-log "Details +
// edit-then-approve" view. Returns the full held log (coach + program names),
// the scheduled block it maps to (via matchLogToBlock — the ONE source of
// truth for "which block did this log belong to"), and the logged-vs-scheduled
// pay figures. Both pay figures use the log's OWN snapshot rate, so the only
// variable between them is duration. No actor — a pure read, gated at the
// public wrapper. Throws HourLogNotFoundError if the row is missing.
export type HeldLogDetail = {
  log: {
    id: string;
    coachId: string;
    coachName: string | null;
    programId: string;
    programName: string;
    startAt: Date;
    endAt: Date;
    note: string | null;
    heldReason: string | null;
    ratePer30MinCents: number | null;
    perSessionRateCents: number | null;
  };
  block: {
    id: string;
    startAt: Date;
    endAt: Date;
    coachNames: string[];
  } | null;
  loggedPayCents: number;
  scheduledPayCents: number | null;
};

export async function getHeldLogDetailInternal(
  id: string,
): Promise<HeldLogDetail> {
  const [log] = await db
    .select({
      id: hourLogs.id,
      coachId: hourLogs.coachId,
      coachName: users.name,
      programId: hourLogs.programId,
      programName: programs.name,
      startAt: hourLogs.startAt,
      endAt: hourLogs.endAt,
      note: hourLogs.note,
      heldReason: hourLogs.heldReason,
      ratePer30MinCents: hourLogs.ratePer30MinCents,
      perSessionRateCents: hourLogs.perSessionRateCents,
      status: hourLogs.status,
    })
    .from(hourLogs)
    .innerJoin(users, eq(hourLogs.coachId, users.id))
    .innerJoin(programs, eq(hourLogs.programId, programs.id))
    .where(eq(hourLogs.id, id))
    .limit(1);
  if (!log) throw new HourLogNotFoundError(id);

  // Find the matched scheduled block — same block-fetch approach as
  // logHourInternal: the coach's own blocks that overlap the log window
  // (half-open; same lt/gte). matchLogToBlock's in-set checks only read
  // `.coaches`, so the scheduled-coach fields just need to exist.
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
        eq(programScheduleBlockCoaches.coachId, log.coachId),
        lt(programScheduleBlocks.startAt, log.endAt),
        gte(programScheduleBlocks.endAt, log.startAt),
      ),
    );
  const blocks: ReconBlock[] = blockRows.map((b) => ({
    id: b.id,
    programId: b.programId,
    scheduledCoachId: log.coachId,
    scheduledCoachName: log.coachName,
    coaches: [{ coachId: log.coachId, coachName: log.coachName ?? "" }],
    startAt: b.startAt,
    endAt: b.endAt,
  }));

  const match = matchLogToBlock(
    {
      coachId: log.coachId,
      programId: log.programId,
      startAt: log.startAt,
      endAt: log.endAt,
    },
    blocks,
  );

  // For a matched block, fetch its FULL scheduled-coach set for display (the
  // block may be shared). The matched block's program always == the log's
  // program (matchLogToBlock filters by programId), so no program lookup.
  let block: HeldLogDetail["block"] = null;
  if (match) {
    const coachRows = await db
      .select({ coachName: users.name })
      .from(programScheduleBlockCoaches)
      .innerJoin(users, eq(programScheduleBlockCoaches.coachId, users.id))
      .where(eq(programScheduleBlockCoaches.blockId, match.id));
    block = {
      id: match.id,
      startAt: match.startAt,
      endAt: match.endAt,
      coachNames: coachRows.map((c) => c.coachName ?? ""),
    };
  }

  // Pay figures off the log's OWN snapshot rate for both — the only
  // difference is the duration (logged window vs the scheduled block).
  const loggedPayCents = workPayForLog({
    perSessionRateCents: log.perSessionRateCents,
    startAt: log.startAt,
    endAt: log.endAt,
    ratePer30MinCents: log.ratePer30MinCents,
  });
  const scheduledPayCents = match
    ? workPayForLog({
        perSessionRateCents: log.perSessionRateCents,
        startAt: match.startAt,
        endAt: match.endAt,
        ratePer30MinCents: log.ratePer30MinCents,
      })
    : null;

  return {
    log: {
      id: log.id,
      coachId: log.coachId,
      coachName: log.coachName,
      programId: log.programId,
      programName: log.programName,
      startAt: log.startAt,
      endAt: log.endAt,
      note: log.note,
      heldReason: log.heldReason,
      ratePer30MinCents: log.ratePer30MinCents,
      perSessionRateCents: log.perSessionRateCents,
    },
    block,
    loggedPayCents,
    scheduledPayCents,
  };
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
