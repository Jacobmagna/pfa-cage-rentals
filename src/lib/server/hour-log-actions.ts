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

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { hourLogs, programRateOverrides, programs } from "@/db/schema";
import { type AuthedSession } from "@/lib/authz";
import { rateForProgram } from "@/lib/billing";
import {
  HourLogNotFoundError,
  ProgramInactiveError,
  ProgramNotFoundError,
} from "@/lib/errors";
import {
  createHourLogSchema,
  editHourLogSchema,
} from "@/lib/schemas/hour-log";
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

  const [inserted] = await db
    .insert(hourLogs)
    .values({
      coachId: actor.id,
      programId: parsed.programId,
      startAt: parsed.startAt,
      endAt: parsed.endAt,
      note: parsed.note ?? null,
      ratePer30MinCents,
      createdBy: actor.id,
    })
    .returning();

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
