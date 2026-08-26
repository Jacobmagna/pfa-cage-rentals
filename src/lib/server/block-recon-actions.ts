// 0r(4) — ADMIN "Change the schedule to <the logged window>", the resolution
// for a `wrong_time` block.
//
// THE PROBLEM THIS SOLVES. `programBlockCoachFlags.kind` has exactly two
// values, `no_show` and `cancelled`, and each has a resolver. `wrong_time` is
// DERIVED live by `reconcileBlocks` on every render, so no admin action could
// clear it: a coach scheduled 10:00–3:00 who actually worked 10:00–1:00 left
// the block red forever, indistinguishable from a coach who never showed.
//
// WHY MOVE THE BLOCK RATHER THAN ADD A THIRD FLAG KIND. A `wrong_time` block
// is not a problem needing an acknowledgement — it is a schedule that no
// longer matches what happened. Moving the block's window to the times the
// coach actually logged makes the schedule TRUE, and the status then goes
// green through the ordinary engine. No new enum value, no migration, no
// stored state to drift.
//
// 🔴 THE WRITE IS DELEGATED TO `updateProgramScheduleBlockInternal`, and that
// is the only correct way to move a block: it re-checks the linked CAGE
// occupancy is free at the new window and moves the `blocked_times` rows with
// it. A bare row update would leave the cage booked at the old time — a
// silent double-book.
//
// ── 📌 THE REASSIGN ACTION THAT USED TO LIVE HERE WAS RETIRED 2026-08-25 ──
// `reassignBlockToLoggedCoachInternal` — the "<coach> covered this — reassign"
// button — moved a `wrong_coach` block's membership from the scheduled coach
// to the one who actually logged it, by ADDING the substitute and REMOVING
// the scheduled coach.
//
// 🔴 IT WAS RETIRED BECAUSE ITS REMOVAL HALF BECAME WRONG. Approving a
// coach's own log now joins him to the block automatically
// (`recorded-work-schedule-sync.ts`), so `wrong_coach` no longer arises from
// the ordinary flow and the button no longer rendered. Where it still could
// fire it DELETED THE SCHEDULED COACH — and deleting him deletes his
// `no_show`, which is the accountability record. Jacob's rule (2026-08-25):
// somebody else covering a shift does not stop the scheduled coach having
// missed it. The button's only remaining behaviour was to erase that.
//
// ▶ An admin who genuinely wants to change who is scheduled uses the block's
// ordinary EDIT, which removes nobody by surprise — the retired button's own
// error copy already pointed there. ▶ rule 27: do not carry a button whose
// only job has been automated.
//
// Lives outside any "use server" file (same reason as block-flag-actions.ts
// and block-handoff-actions.ts): it takes the actor as a parameter, so
// exposing it directly as RPC would let a caller forge an admin identity.
// The requireRole("admin")-gated wrapper is in
// src/app/admin/hour-log/actions.ts.

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  hourLogs,
  programScheduleBlockCoaches,
  programScheduleBlocks,
  users,
} from "@/db/schema";
import { type AuthedSession } from "@/lib/authz";
import {
  BlockNotWrongTimeError,
  MultiCoachBlockTimeMatchError,
  NotAssignedToBlockError,
  ProgramScheduleBlockNotFoundError,
} from "@/lib/errors";
import { matchBlockToLoggedTimesSchema } from "@/lib/schemas/block-recon";
import { reconcileBlocks } from "./reconciliation";
import { updateProgramScheduleBlockInternal } from "./program-schedule-actions";

type Actor = AuthedSession["user"];

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
 * WHY MOVING THE BLOCK, RATHER THAN A THIRD FLAG KIND. The schedule is a
 * PLAN, the log is the RECORD, and when they disagree the record wins.
 * (The retired substitute reassign — see the module header — made the same
 * choice for `wrong_coach`, by a different means.) Correcting the
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
