// ADMIN HOUR ENTRY → THE SCHEDULE. Making the grid show work an admin
// recorded, rather than leaving it red for a shift everybody knows happened.
//
// ── WHAT THIS DOES, AND THE ONE THING IT DELIBERATELY WILL NOT DO ────────
// When an admin records hours for a coach:
//   • a scheduled block of the same program overlapping that window gains
//     the coach as a scheduled member, so the block reconciles GREEN and
//     names everybody who actually worked it;
//   • if there is NO such block, one is created from the entry itself, so
//     work that was never planned still appears on the schedule.
//
// 🔴 IT NEVER MOVES AN EXISTING BLOCK'S TIMES, and that restraint is the
// whole reason this is safe. `isOverLogged` compares a log against ITS
// BLOCK's window, so a block that rewrote itself to match whatever was
// logged would make that comparison zero by construction and the
// hours-overclaim alarm could never fire again — a coach scheduled 10–3 who
// logs 10–6 would silently become "scheduled 10–6" with nobody told. Adding
// a PERSON to a block leaves the window untouched, so the alarm keeps
// working exactly as it did. Moving a block's window is a separate, explicit
// operator decision and already has its own button on the red banner
// ("Change the schedule to <the logged window>").
//
// ── 🔴 WHY NOTHING HERE MAY THROW INTO THE CALLER ────────────────────────
// The hour logs are already written by the time this runs, and they are the
// PAY. neon-http has no transactions, so there is no version of this where a
// failed schedule update un-writes them. A throw would therefore turn "the
// coaches were paid and the grid did not update" into a red error implying
// nothing happened, and the admin's correct response to that — do it again —
// is the one action that risks a duplicate. Every failure is caught and
// RETURNED as an outcome instead, so the caller can report the money as
// written and the schedule as needing attention. Silence is not an option
// either: an unreported skip is a block that stays red for a reason nobody
// can see.

import { and, eq, gt, inArray, isNull, lt } from "drizzle-orm";
import { db } from "@/db";
import {
  programScheduleBlockCoaches,
  programScheduleBlocks,
  programs,
  users,
} from "@/db/schema";
import { safeLogAudit } from "./audit-helpers";
import { matchLogToBlock, type ReconBlock } from "@/lib/server/reconciliation";
import { createProgramScheduleBlockInternal } from "@/lib/server/program-schedule-actions";
import type { AuthedSession } from "@/lib/authz";

/**
 * What the schedule sync did, so the caller can say so out loud.
 *
 * `skipped` carries a REASON rather than being a bare boolean: the two ways
 * this legitimately does nothing (a retired program has no schedule to add
 * to; an admin subject is not a schedulable coach) are both states an
 * operator can act on, and "nothing happened" with no reason is the shape of
 * a bug report nobody can answer.
 */
export type ScheduleSyncOutcome =
  | { kind: "joined"; blockId: string; addedCoachIds: string[] }
  | { kind: "created"; blockId: string; coachIds: string[] }
  | { kind: "unchanged"; blockId: string }
  | {
      kind: "skipped";
      reason: "retired_program" | "not_schedulable" | "failed";
      detail: string;
    };

/**
 * Every block of this program whose window overlaps the entry, shaped for
 * `matchLogToBlock`.
 *
 * 🔴 The candidate set is chosen by PROGRAM + TIME OVERLAP, which is the
 * match key this system uses everywhere else (`reconcileBlocks`,
 * `annotateLogs`, `classifyManualLog`). Inventing a second rule here — a
 * tighter tolerance, say — would let the schedule sync join one block while
 * the reconciliation overlay judged the log against a different one, and the
 * grid would show a coach added to a block that still called them a no-show.
 */
async function overlappingBlocks(
  programId: string,
  startAt: Date,
  endAt: Date,
): Promise<ReconBlock[]> {
  const rows = await db
    .select({
      id: programScheduleBlocks.id,
      programId: programScheduleBlocks.programId,
      scheduledCoachId: programScheduleBlocks.scheduledCoachId,
      startAt: programScheduleBlocks.startAt,
      endAt: programScheduleBlocks.endAt,
    })
    .from(programScheduleBlocks)
    .where(
      and(
        eq(programScheduleBlocks.programId, programId),
        lt(programScheduleBlocks.startAt, endAt),
        gt(programScheduleBlocks.endAt, startAt),
      ),
    );
  if (rows.length === 0) return [];

  const memberRows = await db
    .select({
      blockId: programScheduleBlockCoaches.blockId,
      coachId: programScheduleBlockCoaches.coachId,
      coachName: users.name,
      coachEmail: users.email,
    })
    .from(programScheduleBlockCoaches)
    .innerJoin(users, eq(programScheduleBlockCoaches.coachId, users.id))
    // Scoped to the candidate blocks. Unbounded, this reads every
    // block-coach row in the product to answer a question about one window.
    .where(
      inArray(
        programScheduleBlockCoaches.blockId,
        rows.map((r) => r.id),
      ),
    );

  const byBlock = new Map<string, { coachId: string; coachName: string }[]>();
  for (const m of memberRows) {
    const list = byBlock.get(m.blockId) ?? [];
    list.push({ coachId: m.coachId, coachName: m.coachName ?? m.coachEmail });
    byBlock.set(m.blockId, list);
  }

  return rows.map((r) => {
    const coaches = byBlock.get(r.id) ?? [];
    return {
      id: r.id,
      programId: r.programId,
      scheduledCoachId: r.scheduledCoachId,
      scheduledCoachName:
        coaches.find((c) => c.coachId === r.scheduledCoachId)?.coachName ??
        null,
      coaches,
      startAt: r.startAt,
      endAt: r.endAt,
    };
  });
}

/**
 * Which of these ids may actually sit on a schedule block.
 *
 * `createProgramScheduleBlockInternal` requires role="coach" and refuses
 * anything else with `CoachNotFoundError`. An ADMIN is a legitimate hour-log
 * subject — Mark has a work log — so an admin in the list must not fail the
 * sync for the coaches beside them; they are filtered out here and the
 * caller reports it. Scoped to the ids asked about rather than reading the
 * whole users table, which on production is ~20k rows.
 */
async function schedulableAmong(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        inArray(users.id, ids),
        eq(users.role, "coach"),
        isNull(users.deletedAt),
      ),
    );
  const ok = new Set(rows.map((r) => r.id));
  // Preserve the caller's order — the first schedulable coach becomes the
  // block's primary, and that should be the one the admin picked first.
  return ids.filter((id) => ok.has(id));
}

/**
 * Point the schedule at what an admin just recorded.
 *
 * `coachIds` are the subjects whose hours were written — already resolved,
 * already deduped, and already known to exist.
 */
export async function syncScheduleForAdminEntry(
  actor: AuthedSession["user"],
  entry: {
    programId: string;
    startAt: Date;
    endAt: Date;
    coachIds: string[];
  },
): Promise<ScheduleSyncOutcome> {
  try {
    const blocks = await overlappingBlocks(
      entry.programId,
      entry.startAt,
      entry.endAt,
    );

    // ── An existing block: add whoever is missing from it. ──
    if (blocks.length > 0) {
      // Matched through the canonical matcher rather than by picking the
      // first overlapping row, so this joins the same block the
      // reconciliation overlay will judge these logs against.
      //
      // 📌 The match is run for the FIRST coach in the entry, not for each of
      // them, and that is a real simplification worth stating: one submit is
      // one shift at one window, so every coach in it overlaps the same
      // block(s), and the only way `matchLogToBlock` could return different
      // answers per coach is its in-set preference when SEVERAL blocks of one
      // program overlap the same window. That is a schedule nobody builds on
      // purpose. If it ever shows up, the fix is to match per coach and group
      // the additions by block — not to special-case it here.
      const target =
        matchLogToBlock(
          {
            coachId: entry.coachIds[0],
            programId: entry.programId,
            startAt: entry.startAt,
            endAt: entry.endAt,
          },
          blocks,
        ) ?? blocks[0];

      const already = new Set(target.coaches.map((c) => c.coachId));
      const toAdd = entry.coachIds.filter((id) => !already.has(id));
      if (toAdd.length === 0) {
        return { kind: "unchanged", blockId: target.id };
      }

      // Only role="coach" rows may sit on a block. An admin subject is a
      // legitimate hour-log owner (Mark has a work log) but is not
      // schedulable, so it is filtered rather than allowed to fail the
      // whole sync for the coaches beside them.
      const addable = await schedulableAmong(toAdd);
      if (addable.length === 0) {
        return {
          kind: "skipped",
          reason: "not_schedulable",
          detail:
            "The hours were recorded. The schedule was left alone because " +
            "only coaches can be assigned to a scheduled block.",
        };
      }

      for (const coachId of addable) {
        await db
          .insert(programScheduleBlockCoaches)
          .values({ blockId: target.id, coachId })
          .onConflictDoNothing({
            target: [
              programScheduleBlockCoaches.blockId,
              programScheduleBlockCoaches.coachId,
            ],
          });
      }

      // A block with no primary (an "Unassigned" block) gets one, so the
      // grid stops labelling it Unassigned once somebody is on it.
      if (target.scheduledCoachId === null) {
        await db
          .update(programScheduleBlocks)
          .set({ scheduledCoachId: addable[0] })
          .where(eq(programScheduleBlocks.id, target.id));
      }

      await safeLogAudit(db, {
        actorUserId: actor.id,
        entityType: "program_schedule_block",
        entityId: target.id,
        action: "update",
        before: {
          scheduledCoachIds: target.coaches.map((c) => c.coachId),
        } as unknown as Record<string, unknown>,
        after: {
          scheduledCoachIds: [
            ...target.coaches.map((c) => c.coachId),
            ...addable,
          ],
          reason: "admin recorded hours for this window",
        } as unknown as Record<string, unknown>,
      });

      return { kind: "joined", blockId: target.id, addedCoachIds: addable };
    }

    // ── No block at all: create one from the entry. ──
    const [program] = await db
      .select({ id: programs.id, name: programs.name, active: programs.active })
      .from(programs)
      .where(eq(programs.id, entry.programId))
      .limit(1);

    // A retired program cannot take a new block — `createProgramScheduleBlock`
    // asserts the program is active, and that check is right: a retired
    // program should not gain future schedule. The headline case for admin
    // entry is exactly this (a summer program switched off in August), so it
    // is reported rather than treated as a failure.
    if (!program || !program.active) {
      return {
        kind: "skipped",
        reason: "retired_program",
        detail:
          "The hours were recorded and will be paid. No schedule block was " +
          "created because this program is retired.",
      };
    }

    const addable = await schedulableAmong(entry.coachIds);
    if (addable.length === 0) {
      return {
        kind: "skipped",
        reason: "not_schedulable",
        detail:
          "The hours were recorded. No schedule block was created because " +
          "only coaches can be assigned to one.",
      };
    }

    const created = await createProgramScheduleBlockInternal(actor, {
      programId: entry.programId,
      scheduledCoachIds: addable,
      startAt: entry.startAt,
      endAt: entry.endAt,
      // No cage occupancy: the admin recorded WORK, and claiming a lane on
      // their behalf would book a resource nobody asked for — and, for a
      // past date, one that may already be booked to somebody else.
      resourceIds: [],
    });

    return { kind: "created", blockId: created.id, coachIds: addable };
  } catch (err) {
    // ▶ See the module header: the pay is already written, so this can only
    // ever be reported, never rethrown.
    return {
      kind: "skipped",
      reason: "failed",
      detail:
        "The hours were recorded and will be paid, but the schedule could " +
        "not be updated. Check the block on the schedule page. " +
        (err instanceof Error ? err.message : "Unknown error"),
    };
  }
}
