// 0r(1) — ADMIN substitute-coach reassign: "Tyler covered this — reassign".
//
// THE PROBLEM THIS SOLVES. `programBlockCoachFlags.kind` has exactly two
// values, `no_show` and `cancelled`, and each has a resolver. `wrong_coach`
// and `wrong_time` have neither — they are DERIVED live by `reconcileBlocks`
// on every render, so no admin action could clear them. A substitution that
// was handled perfectly (the substitute logs it, the admin approves it and
// deletes the scheduled coach's log) stayed red forever and was visually
// indistinguishable from a coach who never showed up. Real case: Lucas
// Milone scheduled Front Desk Sat Aug 8 10:00–3:00, Tyler Garcia worked it.
//
// WHY REASSIGNMENT RATHER THAN A THIRD FLAG KIND. A `wrong_coach` block is
// not a problem needing an acknowledgement — it is a schedule that no longer
// matches what happened. Moving the block's membership to the coach who
// actually worked it makes the schedule TRUE, and the status then goes green
// through the ordinary engine: Tyler is in the coach set, his log is within
// tolerance, `reconcileBlocks` returns `logged`. No new enum value, no
// migration, no stored state to drift, and nothing new for a future reader
// to keep in sync. A third flag kind would instead have added a second,
// parallel notion of "resolved" alongside a status that still said red.
//
// 🔴 THE LOAD-BEARING GUARD. This action will ONLY move a block to a coach
// who already has a POSTED hour-log overlapping that block's program and
// window. Without that check this would be an unaudited way to move a shift
// onto any coach at all — including one who never worked, whose pay follows
// membership on the no-show derivation. The reassignment is therefore never
// the admin's claim about what happened; it is the system agreeing with a
// log the coach already wrote. An admin who genuinely wants to change who is
// scheduled uses the normal block edit, which makes no such claim.
//
// Pay is NOT touched and cannot move: pay derives from `hour_logs`, and this
// action writes only block membership. Tyler is already being paid for the
// log he wrote; Lucas has no log to lose.
//
// Lives outside any "use server" file (same reason as block-flag-actions.ts
// and block-handoff-actions.ts): it takes the actor as a parameter, so
// exposing it directly as RPC would let a caller forge an admin identity.
// The requireRole("admin")-gated wrapper is in
// src/app/admin/hour-log/actions.ts.
//
// neon-http is stateless HTTP with no transactions, so the membership swap
// is a sequence ordered add → repoint-primary → remove, exactly as
// reassignOwnBlockInternal does it: a mid-sequence failure can leave the
// block with BOTH coaches briefly, but never with none.

import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
  hourLogs,
  programScheduleBlockCoaches,
  programScheduleBlocks,
  users,
} from "@/db/schema";
import { type AuthedSession } from "@/lib/authz";
import { isLogScheduled } from "@/lib/coach-hour-log";
import {
  BlockNotWrongTimeError,
  CoachDidNotLogBlockError,
  InvalidHandoffTargetError,
  MultiCoachBlockTimeMatchError,
  NotAssignedToBlockError,
  ProgramScheduleBlockNotFoundError,
  ScheduledCoachAlreadyLoggedError,
} from "@/lib/errors";
import {
  matchBlockToLoggedTimesSchema,
  reassignBlockToLoggedCoachSchema,
} from "@/lib/schemas/block-recon";
import { reconcileBlocks } from "./reconciliation";
import { updateProgramScheduleBlockInternal } from "./program-schedule-actions";
import { safeLogAudit } from "./audit-helpers";

type Actor = AuthedSession["user"];

/**
 * True iff `coachId` has a POSTED hour-log for `block.programId` whose
 * window overlaps the block's. Deliberately reuses `isLogScheduled` — the
 * same programId + half-open-overlap predicate the reconciliation engine
 * and the coach confirm list use — so "did this coach work it?" cannot be
 * answered one way here and another way by the banner that offered the
 * button.
 *
 * `posted` only: a held log is explicitly NOT payable and not counted
 * anywhere, so it is not evidence that the work happened.
 */
async function hasPostedLogCoveringBlock(
  coachId: string,
  block: { programId: string; startAt: Date; endAt: Date },
): Promise<boolean> {
  const logs = await db
    .select({
      programId: hourLogs.programId,
      startAt: hourLogs.startAt,
      endAt: hourLogs.endAt,
    })
    .from(hourLogs)
    .where(
      and(
        eq(hourLogs.coachId, coachId),
        eq(hourLogs.programId, block.programId),
        eq(hourLogs.status, "posted"),
      ),
    );

  return isLogScheduled(
    {
      programId: block.programId,
      startMs: block.startAt.getTime(),
      endMs: block.endAt.getTime(),
    },
    logs.map((l) => ({
      programId: l.programId,
      startMs: l.startAt.getTime(),
      endMs: l.endAt.getTime(),
    })),
  );
}

/**
 * Reassigns ONE block occurrence from the scheduled coach who did not work
 * it to the coach who did. Asserts, in order: the block exists · `from` is
 * a member · `to` is a different active coach · `to` has a posted log
 * covering the block · `from` does NOT. Then swaps membership and audits.
 *
 * Touches only this occurrence — a recurring series is unaffected, matching
 * the block dialog's existing single-occurrence-vs-series separation.
 */
export async function reassignBlockToLoggedCoachInternal(
  actor: Actor,
  input: unknown,
) {
  const { blockId, fromCoachId, toCoachId } =
    reassignBlockToLoggedCoachSchema.parse(input);

  if (fromCoachId === toCoachId) {
    throw new InvalidHandoffTargetError(toCoachId);
  }

  const [block] = await db
    .select({
      id: programScheduleBlocks.id,
      programId: programScheduleBlocks.programId,
      scheduledCoachId: programScheduleBlocks.scheduledCoachId,
      startAt: programScheduleBlocks.startAt,
      endAt: programScheduleBlocks.endAt,
    })
    .from(programScheduleBlocks)
    .where(eq(programScheduleBlocks.id, blockId))
    .limit(1);
  if (!block) throw new ProgramScheduleBlockNotFoundError(blockId);

  // `from` must actually be scheduled here, or there is no membership row
  // to move and the caller is working from a stale render.
  const [membership] = await db
    .select({ coachId: programScheduleBlockCoaches.coachId })
    .from(programScheduleBlockCoaches)
    .where(
      and(
        eq(programScheduleBlockCoaches.blockId, blockId),
        eq(programScheduleBlockCoaches.coachId, fromCoachId),
      ),
    )
    .limit(1);
  if (!membership) throw new NotAssignedToBlockError(blockId, fromCoachId);

  // `to` must be an active, non-deleted coach. Admins are not valid
  // targets, matching the coach-side hand-off picker.
  const [recipient] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.id, toCoachId),
        eq(users.role, "coach"),
        isNull(users.deletedAt),
      ),
    )
    .limit(1);
  if (!recipient) throw new InvalidHandoffTargetError(toCoachId);

  // 🔴 The guard that makes this action safe — see the module header.
  if (!(await hasPostedLogCoveringBlock(toCoachId, block))) {
    throw new CoachDidNotLogBlockError(blockId, toCoachId);
  }

  // And the converse: if the scheduled coach DID log it, this block is not
  // a wrong_coach case, and reassigning would take a shift away from the
  // coach who can prove they worked it.
  if (await hasPostedLogCoveringBlock(fromCoachId, block)) {
    throw new ScheduledCoachAlreadyLoggedError(blockId, fromCoachId);
  }

  const wasPrimary = block.scheduledCoachId === fromCoachId;

  // 1. Add the recipient (idempotent on the composite PK).
  await db
    .insert(programScheduleBlockCoaches)
    .values({ blockId, coachId: toCoachId })
    .onConflictDoNothing({
      target: [
        programScheduleBlockCoaches.blockId,
        programScheduleBlockCoaches.coachId,
      ],
    });

  // 2. Repoint the primary if the departing coach held it, so the grid
  //    label and the reconciliation agree.
  if (wasPrimary) {
    await db
      .update(programScheduleBlocks)
      .set({ scheduledCoachId: toCoachId })
      .where(eq(programScheduleBlocks.id, blockId));
  }

  // 3. Remove the departing coach.
  await db
    .delete(programScheduleBlockCoaches)
    .where(
      and(
        eq(programScheduleBlockCoaches.blockId, blockId),
        eq(programScheduleBlockCoaches.coachId, fromCoachId),
      ),
    );

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "program_schedule_block",
    entityId: blockId,
    action: "update",
    before: {
      substituteReassignFromCoachId: fromCoachId,
      scheduledCoachId: block.scheduledCoachId,
    },
    after: {
      substituteReassignToCoachId: toCoachId,
      scheduledCoachId: wasPrimary ? toCoachId : block.scheduledCoachId,
    },
  });

  return { blockId, fromCoachId, toCoachId };
}

/**
 * Loads a block, its scheduled coaches and every log overlapping its
 * program, and runs the REAL reconciliation engine over them — the same
 * function the grid and the banner render from. Returns the per-coach
 * result for `coachId`.
 *
 * 🔴 Re-deriving rather than trusting the client is the whole safety story
 * for the time-match action: it means the server's idea of "this is a
 * wrong_time block and the coach logged 10:00–1:00" cannot differ from the
 * banner the admin clicked, and a stale render simply fails the guard
 * instead of moving a block to a window nobody worked.
 */
async function reconcileOneBlock(blockId: string, coachId: string) {
  const [block] = await db
    .select()
    .from(programScheduleBlocks)
    .where(eq(programScheduleBlocks.id, blockId))
    .limit(1);
  if (!block) throw new ProgramScheduleBlockNotFoundError(blockId);

  const coachRows = await db
    .select({
      coachId: programScheduleBlockCoaches.coachId,
      coachName: users.name,
      coachEmail: users.email,
    })
    .from(programScheduleBlockCoaches)
    .innerJoin(users, eq(users.id, programScheduleBlockCoaches.coachId))
    .where(eq(programScheduleBlockCoaches.blockId, blockId));

  // Posted only, matching every counting read in the product.
  const logRows = await db
    .select({
      coachId: hourLogs.coachId,
      coachName: users.name,
      coachEmail: users.email,
      programId: hourLogs.programId,
      startAt: hourLogs.startAt,
      endAt: hourLogs.endAt,
    })
    .from(hourLogs)
    .innerJoin(users, eq(users.id, hourLogs.coachId))
    .where(
      and(
        eq(hourLogs.programId, block.programId),
        eq(hourLogs.status, "posted"),
      ),
    );

  const coaches = coachRows.map((c) => ({
    coachId: c.coachId,
    coachName: c.coachName ?? c.coachEmail,
  }));

  const result = reconcileBlocks(
    {
      blocks: [
        {
          id: block.id,
          programId: block.programId,
          scheduledCoachId: block.scheduledCoachId,
          scheduledCoachName:
            coaches.find((c) => c.coachId === block.scheduledCoachId)
              ?.coachName ?? null,
          coaches,
          startAt: block.startAt,
          endAt: block.endAt,
        },
      ],
      logs: logRows.map((l) => ({
        coachId: l.coachId,
        coachName: l.coachName ?? l.coachEmail,
        programId: l.programId,
        startAt: l.startAt,
        endAt: l.endAt,
      })),
      // The engine only uses `now` to decide no_show vs pending, neither of
      // which this action accepts — but it is injected rather than defaulted
      // because the engine takes no clock of its own by design.
      now: new Date(),
    },
    // The engine formats times only into `detail` strings, which this path
    // does not read. ISO keeps it locale- and TZ-independent.
    (d) => d.toISOString().slice(11, 16),
  );

  const forCoach = result[blockId]?.coaches.find((c) => c.coachId === coachId);
  return { block, coaches, forCoach };
}

/**
 * 0r(4) — MATCH THE SCHEDULE TO WHAT HAPPENED. Moves a `wrong_time` block's
 * window onto the times the scheduled coach actually logged, after which it
 * reconciles as `logged` through the ordinary engine.
 *
 * WHY MOVING THE BLOCK, RATHER THAN A THIRD FLAG KIND. It is the same choice
 * the substitute reassign makes one function up: the schedule is a PLAN, the
 * log is the RECORD, and when they disagree the record wins. Correcting the
 * plan needs no new enum value, no migration, and leaves no stored "resolved"
 * marker that can drift out of sync with a status still painting red. The
 * original scheduled window is not lost — `updateProgramScheduleBlockInternal`
 * writes a before/after audit row containing it.
 *
 * 🔴 DELEGATES the write to `updateProgramScheduleBlockInternal` instead of
 * updating the row here. That function is the ONLY correct way to move a
 * block: it re-validates the program and coach, re-checks the block's linked
 * cage occupancy is free at the new window, MOVES the linked `blocked_times`
 * rows with it (a bare row update would leave the cage booked at the old
 * time — a silent double-book), translates a concurrent exclusion violation
 * into a friendly BlockOverlapError, and audits. Re-implementing any of that
 * would be a second, quietly-diverging copy.
 *
 * Only this occurrence moves; a recurring series is untouched, matching the
 * block dialog's occurrence-vs-series separation.
 */
export async function matchBlockToLoggedTimesInternal(
  actor: Actor,
  input: unknown,
) {
  const { blockId, coachId } = matchBlockToLoggedTimesSchema.parse(input);

  const { block, coaches, forCoach } = await reconcileOneBlock(
    blockId,
    coachId,
  );

  // Not scheduled here → nothing of this coach's to correct.
  if (!coaches.some((c) => c.coachId === coachId)) {
    throw new NotAssignedToBlockError(blockId, coachId);
  }

  // 🔴 Refuse on a shared block — see MultiCoachBlockTimeMatchError. Moving
  // the window to fit one coach re-reconciles it for everyone else on it.
  if (coaches.length > 1) {
    throw new MultiCoachBlockTimeMatchError(blockId);
  }

  // The engine — not the caller — decides this is a wrong_time block, and
  // the engine's own `loggedWindow` is what we move to.
  //
  // 📌 A MUTATION DELETING THE `status` HALF OF THIS CHECK SURVIVES, AND
  // THAT IS CORRECT — recorded so nobody re-hunts it. `loggedWindow` is
  // populated by exactly one branch of the engine (`wrong_time`), so the two
  // conditions cannot disagree and no fixture can satisfy one without the
  // other (rule 21's "write the fixture that satisfies exactly ONE" is
  // impossible here — which per rule 27 means the surviving mutation is
  // telling us the condition is redundant, not that a test is missing).
  // It is kept because it states the precondition in the same words the UI
  // and the docs use, and it would still hold if a future engine change ever
  // populated `loggedWindow` elsewhere. **The invariant it leans on is
  // pinned at the engine instead**, by `reconciliation.test.ts` →
  // "%s exposes no time-match target", which asserts `loggedWindow` is null
  // for logged / wrong_coach / no_show / pending.
  if (
    !forCoach ||
    forCoach.status !== "wrong_time" ||
    forCoach.loggedWindow === null
  ) {
    throw new BlockNotWrongTimeError(blockId, coachId);
  }

  const { startAt, endAt } = forCoach.loggedWindow;

  // Defensive: a no-op move would be a confusing audit row claiming a
  // correction that changed nothing. The engine cannot produce this (a
  // within-tolerance log returns `logged`), so it is a belt-and-braces
  // guard, not a reachable branch.
  if (
    startAt.getTime() === block.startAt.getTime() &&
    endAt.getTime() === block.endAt.getTime()
  ) {
    throw new BlockNotWrongTimeError(blockId, coachId);
  }

  const updated = await updateProgramScheduleBlockInternal(actor, blockId, {
    startAt,
    endAt,
  });

  return {
    blockId,
    coachId,
    startAt: updated.startAt,
    endAt: updated.endAt,
  };
}
