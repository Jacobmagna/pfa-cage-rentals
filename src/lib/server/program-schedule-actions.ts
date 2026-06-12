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
import {
  blockedTimes,
  programs,
  programScheduleBlockCoaches,
  programScheduleBlocks,
  users,
} from "@/db/schema";
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
import {
  assertResourcesFree,
  insertProgramResourceBlocks,
  isExclusionViolation,
  programOccupancyReason,
} from "./program-resource-blocks";
import { BlockOverlapError } from "@/lib/errors";

const AUDIT_ENTITY = "program_schedule_block";

// Program must exist and be active. Same check as the hour-log create
// path. Throws ProgramNotFoundError / ProgramInactiveError. Returns the
// program NAME so the caller can stamp it on occupancy blocked_times
// (reason = "Program: <name>").
async function assertProgramActive(programId: string): Promise<string> {
  const [program] = await db
    .select()
    .from(programs)
    .where(eq(programs.id, programId))
    .limit(1);
  if (!program) throw new ProgramNotFoundError(programId);
  if (!program.active) {
    throw new ProgramInactiveError(program.id, program.name);
  }
  return program.name;
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

  const programName = await assertProgramActive(parsed.programId);
  // QA10 W3.2: full coach set; primary = [0]. Validate EACH coach, then
  // dedupe (preserving order) for the join rows.
  // QA-R2 #10: coach is OPTIONAL — an empty array means no coach assigned
  // (primary = null, no join rows). Validate any ids that ARE provided.
  const primaryCoachId = parsed.scheduledCoachIds[0] ?? null;
  for (const coachId of parsed.scheduledCoachIds) {
    await assertScheduledCoach(coachId);
  }
  const coachIds = [...new Set(parsed.scheduledCoachIds)];

  // QA10 W3.3: occupied cage resources → linked blocked_times. neon-http
  // has no transactions, so PRE-VALIDATE every resource is free at this
  // time BEFORE inserting the block (no orphan block on conflict).
  const resourceIds = [...new Set(parsed.resourceIds ?? [])];
  if (resourceIds.length > 0) {
    await assertResourcesFree(resourceIds, parsed.startAt, parsed.endAt);
  }

  const [inserted] = await db
    .insert(programScheduleBlocks)
    .values({
      programId: parsed.programId,
      scheduledCoachId: primaryCoachId,
      startAt: parsed.startAt,
      endAt: parsed.endAt,
      note: parsed.note ?? null,
      createdBy: actor.id,
    })
    .returning();

  // QA-R2 #10: only write join rows when at least one coach is assigned.
  if (coachIds.length > 0) {
    await db
      .insert(programScheduleBlockCoaches)
      .values(coachIds.map((coachId) => ({ blockId: inserted.id, coachId })));
  }

  // QA10 W3.3: write one linked blocked_time per occupied resource.
  //
  // assertResourcesFree pre-checked these slots, but it's read-then-write and
  // neon-http has no transactions, so a concurrent booking can collide in the
  // race window → the blocked_times EXCLUDE constraint (23P01) rejects this
  // insert. insertProgramResourceBlocks translates that into a friendly
  // BlockOverlapError, but the program block + coach rows were already
  // inserted in the statements above. With no transaction to roll back, we run
  // a COMPENSATING DELETE of the just-inserted block (its coach rows + any
  // partial occupancy cascade away via FK ON DELETE CASCADE) so NO orphan
  // remains, then rethrow the friendly error for the UI. Happy path unchanged.
  if (resourceIds.length > 0) {
    try {
      await insertProgramResourceBlocks(
        resourceIds.map((resourceId) => ({
          programScheduleBlockId: inserted.id,
          resourceId,
          startAt: parsed.startAt,
          endAt: parsed.endAt,
          reason: programOccupancyReason(programName),
          createdBy: actor.id,
        })),
      );
    } catch (err) {
      // Best-effort compensating delete; ON DELETE CASCADE removes the coach
      // join rows and any linked blocked_times. Swallow a cleanup failure so
      // the user still sees the real (overlap) error, not a cleanup error.
      try {
        await db
          .delete(programScheduleBlocks)
          .where(eq(programScheduleBlocks.id, inserted.id));
      } catch {
        // Leave the original error to propagate; the orphan, if any, is
        // visible to the admin to delete manually — far better than swapping
        // the meaningful overlap error for a cleanup error.
      }
      throw err;
    }
  }

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
  const finalStartAt = parsed.startAt ?? existing.startAt;
  const finalEndAt = parsed.endAt ?? existing.endAt;
  // QA10 W3.2: when scheduledCoachIds is provided, primary = [0] and the
  // full join set is REPLACED; when omitted, coaches (and the primary
  // scheduledCoachId) are left untouched.
  // QA-R2 #10: an explicitly-provided EMPTY array clears the assignment
  // (primary = null, join rows removed). Omitted (undefined) still = leave
  // untouched.
  const coachIdsProvided = parsed.scheduledCoachIds !== undefined;
  const primaryCoachId = coachIdsProvided
    ? (parsed.scheduledCoachIds![0] ?? null)
    : existing.scheduledCoachId;

  const programName = await assertProgramActive(finalProgramId);
  if (coachIdsProvided) {
    for (const coachId of parsed.scheduledCoachIds!) {
      await assertScheduledCoach(coachId);
    }
  } else if (primaryCoachId !== null) {
    // Re-validate the unchanged primary, mirroring the program re-check.
    // (Skipped when the existing block is already coachless.)
    await assertScheduledCoach(primaryCoachId);
  }

  // QA10 W3.3: resolve the occupancy change BEFORE mutating anything
  // (neon-http has no transactions — pre-validate, then write).
  //   - resourceIds provided  → REPLACE the linked set at the final time.
  //   - resourceIds undefined  → leave occupancy as-is, but if the TIME
  //     changed, the existing linked blocks must MOVE to the new time;
  //     re-check those resources are free there (excluding this block's
  //     own rows) so we never silently move onto a busy slot.
  const resourceIdsProvided = parsed.resourceIds !== undefined;
  const timeChanged =
    finalStartAt.getTime() !== existing.startAt.getTime() ||
    finalEndAt.getTime() !== existing.endAt.getTime();

  // The block's CURRENT linked blocked_times (for the move/replace paths).
  // Select the FULL rows (not just id/resourceId) so the occupancy-replace
  // branch below can faithfully RESTORE them if the new-occupancy insert trips
  // a concurrent 23P01 after the old rows were deleted (no transactions).
  const existingLinked = await db
    .select()
    .from(blockedTimes)
    .where(eq(blockedTimes.programScheduleBlockId, id));

  if (resourceIdsProvided) {
    const newResourceIds = [...new Set(parsed.resourceIds!)];
    if (newResourceIds.length > 0) {
      await assertResourcesFree(newResourceIds, finalStartAt, finalEndAt, {
        excludeProgramBlockId: id,
      });
    }
  } else if (timeChanged && existingLinked.length > 0) {
    // Propagate the move: re-check the block's OWN occupied resources are
    // free at the new time, excluding this block's own linked rows.
    const ownResourceIds = [
      ...new Set(existingLinked.map((r) => r.resourceId)),
    ];
    await assertResourcesFree(ownResourceIds, finalStartAt, finalEndAt, {
      excludeProgramBlockId: id,
    });
  }

  const blockSet = {
    ...(parsed.programId !== undefined && { programId: parsed.programId }),
    ...(coachIdsProvided && { scheduledCoachId: primaryCoachId }),
    ...(parsed.startAt !== undefined && { startAt: parsed.startAt }),
    ...(parsed.endAt !== undefined && { endAt: parsed.endAt }),
    ...(parsed.note !== undefined && { note: parsed.note ?? null }),
  };
  let updated;
  if (Object.keys(blockSet).length > 0) {
    [updated] = await db
      .update(programScheduleBlocks)
      .set(blockSet)
      .where(eq(programScheduleBlocks.id, id))
      .returning();
  } else {
    updated = existing; // only occupancy/coaches changed — block row untouched
  }

  // Replace the join set only when a new coach list was provided.
  // QA-R2 #10: an empty provided array clears membership (delete, no insert).
  if (coachIdsProvided) {
    const coachIds = [...new Set(parsed.scheduledCoachIds!)];
    await db
      .delete(programScheduleBlockCoaches)
      .where(eq(programScheduleBlockCoaches.blockId, id));
    if (coachIds.length > 0) {
      await db
        .insert(programScheduleBlockCoaches)
        .values(coachIds.map((coachId) => ({ blockId: id, coachId })));
    }
  }

  // QA10 W3.3: apply the occupancy change.
  if (resourceIdsProvided) {
    // Replace the linked blocked_times with the new set at the final time.
    const newResourceIds = [...new Set(parsed.resourceIds!)];
    await db
      .delete(blockedTimes)
      .where(eq(blockedTimes.programScheduleBlockId, id));
    if (newResourceIds.length > 0) {
      try {
        await insertProgramResourceBlocks(
          newResourceIds.map((resourceId) => ({
            programScheduleBlockId: id,
            resourceId,
            startAt: finalStartAt,
            endAt: finalEndAt,
            reason: programOccupancyReason(programName),
            createdBy: actor.id,
          })),
        );
      } catch (err) {
        // Concurrent 23P01 (translated to BlockOverlapError) AFTER we deleted
        // the block's old occupancy. With no transaction, the block would be
        // left NOT occupying any cage = silent double-book. Best-effort RESTORE
        // the original linked blocked_times (snapshotted above) so the block
        // keeps occupying its prior slots, then rethrow the friendly error so
        // the admin's edit fails cleanly with "that cage is busy".
        if (existingLinked.length > 0) {
          try {
            await db.insert(blockedTimes).values(
              existingLinked.map((r) => ({
                id: r.id,
                resourceId: r.resourceId,
                startAt: r.startAt,
                endAt: r.endAt,
                reason: r.reason,
                programScheduleBlockId: r.programScheduleBlockId,
                createdBy: r.createdBy,
                createdAt: r.createdAt,
              })),
            );
          } catch {
            // Restore best-effort; surface the original overlap error.
          }
        }
        throw err;
      }
    }
  } else if (timeChanged && existingLinked.length > 0) {
    // Keep the same resource set, just move the linked blocks to the new
    // time. Reason carries the program name (re-stamp in case it changed).
    // A concurrent booking can grab the destination slot in the race window
    // between the pre-check above and this in-place UPDATE, throwing a raw
    // 23P01. Translate it to the friendly BlockOverlapError (re-querying to
    // name the colliding block), matching the replace-branch / create path.
    // This is an in-place move (no prior delete) so NO compensating restore
    // is needed — just translate. Non-23P01 errors rethrow untranslated.
    try {
      await db
        .update(blockedTimes)
        .set({
          startAt: finalStartAt,
          endAt: finalEndAt,
          reason: programOccupancyReason(programName),
        })
        .where(eq(blockedTimes.programScheduleBlockId, id));
    } catch (err) {
      if (!isExclusionViolation(err)) throw err;
      const ownResourceIds = [
        ...new Set(existingLinked.map((r) => r.resourceId)),
      ];
      // Re-query to name the colliding block (excluding this block's own
      // linked rows). On a collision this throws a named BlockOverlapError.
      await assertResourcesFree(ownResourceIds, finalStartAt, finalEndAt, {
        excludeProgramBlockId: id,
      });
      // 23P01 but the racing row is already gone — surface a generic-but-
      // friendly overlap rather than a raw 500.
      throw new BlockOverlapError(
        ownResourceIds[0],
        programOccupancyReason(programName),
        finalStartAt,
        finalEndAt,
      );
    }
  }

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
