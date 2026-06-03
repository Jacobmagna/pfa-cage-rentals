// Internal program-schedule-block mutation logic. Lives outside any
// "use server" file because Next.js exposes every async export from
// "use server" files as a public RPC endpoint — these functions take
// the actor as a parameter, so exposing them would let anyone forge an
// admin identity.
//
// Public wrappers in src/app/admin/hour-log/schedule/actions.ts gate
// these with requireRole("admin").
//
// Pipeline mirrors block-actions.ts / hour-log-actions.ts, SIMPLIFIED —
// there is NO overlap/EXCLUDE and NO cross-table check. The admin
// authors these blocks deliberately; overlapping program blocks are
// allowed (programs are unrelated to cage resources).
//
//   1. Zod-parse
//   2. Validate program exists + active (ProgramNotFound/ProgramInactive)
//   3. Validate scheduled coach is a non-deleted role=coach user
//      (CoachNotFoundError) — admins are NOT schedulable as the runner
//   4. Insert / update / delete
//   5. Audit (sequential — neon-http has no transactions; safeLogAudit
//      swallows + Sentry-captures audit failures so a logging hiccup
//      never loses a mutation)

import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { programs, programScheduleBlocks, users } from "@/db/schema";
import type { AuthedSession } from "@/lib/authz";
import {
  CoachNotFoundError,
  ProgramInactiveError,
  ProgramNotFoundError,
  ProgramScheduleBlockNotFoundError,
} from "@/lib/errors";
import {
  createProgramScheduleBlockSchema,
  updateProgramScheduleBlockSchema,
} from "@/lib/schemas/program-schedule";
import { safeLogAudit } from "./audit-helpers";

const AUDIT_ENTITY = "program_schedule_block";

// Program must exist and be active. Same check as the hour-log create
// path. Throws ProgramNotFoundError / ProgramInactiveError.
async function assertProgramActive(programId: string) {
  const [program] = await db
    .select()
    .from(programs)
    .where(eq(programs.id, programId))
    .limit(1);
  if (!program) throw new ProgramNotFoundError(programId);
  if (!program.active) {
    throw new ProgramInactiveError(program.id, program.name);
  }
}

// Scheduled coach must be a non-deleted user with role = "coach".
// Admins are NOT schedulable as the running coach (the dropdown lists
// coaches only, like the cage grid's coach picker). Throws
// CoachNotFoundError if it doesn't resolve to such a user.
async function assertScheduledCoach(coachId: string) {
  const [coach] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.id, coachId),
        eq(users.role, "coach"),
        isNull(users.deletedAt),
      ),
    )
    .limit(1);
  if (!coach) throw new CoachNotFoundError(coachId);
}

export async function createProgramScheduleBlockInternal(
  actor: AuthedSession["user"],
  input: unknown,
) {
  const parsed = createProgramScheduleBlockSchema.parse(input);

  await assertProgramActive(parsed.programId);
  await assertScheduledCoach(parsed.scheduledCoachId);

  const [inserted] = await db
    .insert(programScheduleBlocks)
    .values({
      programId: parsed.programId,
      scheduledCoachId: parsed.scheduledCoachId,
      startAt: parsed.startAt,
      endAt: parsed.endAt,
      note: parsed.note ?? null,
      createdBy: actor.id,
    })
    .returning();

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: AUDIT_ENTITY,
    entityId: inserted.id,
    action: "create",
    after: inserted as unknown as Record<string, unknown>,
  });
  return inserted;
}

export async function updateProgramScheduleBlockInternal(
  actor: AuthedSession["user"],
  id: string,
  input: unknown,
) {
  const [existing] = await db
    .select()
    .from(programScheduleBlocks)
    .where(eq(programScheduleBlocks.id, id))
    .limit(1);
  if (!existing) throw new ProgramScheduleBlockNotFoundError(id);

  const parsed = updateProgramScheduleBlockSchema.parse(input);

  // Re-validate against the FINAL values: a program must always be
  // active and the scheduled coach must always be a coach, even if the
  // update only touches times (re-checking the unchanged values is
  // cheap and keeps the row consistent if the program was retired
  // between create and edit).
  const finalProgramId = parsed.programId ?? existing.programId;
  const finalCoachId = parsed.scheduledCoachId ?? existing.scheduledCoachId;

  await assertProgramActive(finalProgramId);
  await assertScheduledCoach(finalCoachId);

  const [updated] = await db
    .update(programScheduleBlocks)
    .set({
      ...(parsed.programId !== undefined && { programId: parsed.programId }),
      ...(parsed.scheduledCoachId !== undefined && {
        scheduledCoachId: parsed.scheduledCoachId,
      }),
      ...(parsed.startAt !== undefined && { startAt: parsed.startAt }),
      ...(parsed.endAt !== undefined && { endAt: parsed.endAt }),
      ...(parsed.note !== undefined && { note: parsed.note ?? null }),
    })
    .where(eq(programScheduleBlocks.id, id))
    .returning();

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: AUDIT_ENTITY,
    entityId: id,
    action: "update",
    before: existing as unknown as Record<string, unknown>,
    after: updated as unknown as Record<string, unknown>,
  });
  return updated;
}

export async function deleteProgramScheduleBlockInternal(
  actor: AuthedSession["user"],
  id: string,
) {
  const [existing] = await db
    .select()
    .from(programScheduleBlocks)
    .where(eq(programScheduleBlocks.id, id))
    .limit(1);
  if (!existing) throw new ProgramScheduleBlockNotFoundError(id);

  await db
    .delete(programScheduleBlocks)
    .where(eq(programScheduleBlocks.id, id));

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: AUDIT_ENTITY,
    entityId: id,
    action: "delete",
    before: existing as unknown as Record<string, unknown>,
  });
}
