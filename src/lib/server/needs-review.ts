// QA10 W3-polish15b: server-only derivation of the admin "needs review"
// block-accountability queue. Two kinds of alert:
//
//   • cancelled — a coach actively cancelled their assignment to a
//     scheduled program block (a program_block_coach_flags row with
//     kind='cancelled' that no admin has resolved yet, i.e. reviewedAt is
//     NULL). These are stored, so we just fetch the open ones.
//
//   • no_show — DERIVED (no stored row): a scheduled block that has ENDED,
//     where a coach who is a MEMBER of the block has NO matching hour-log
//     (same program, overlapping time), AND there is no existing flag for
//     that (block, coach) — neither a 'cancelled' (the coach told us in
//     advance) nor a 'no_show' (an admin already acknowledged it).
//     Acknowledging a no-show inserts a stored 'no_show' flag, which is why
//     an already-acknowledged one drops off here. A no-show only becomes
//     visible once the current time is at/after 8:00 AM Pacific on the
//     calendar day AFTER the block ended (see `noShowDueAt`) — so a block
//     that just ended doesn't alarm during the same business day.
//
// ── 🔴 A NO-SHOW NEVER EXPIRES (Mark, 2026-08-26) ───────────────────────────
// This queue USED TO bound the no_show derivation to a SLIDING 30-day window
// "so the derivation stays cheap and the queue never grows without bound".
// That was never a decision about accountability, and it silently deleted
// one: an unreviewed no-show simply stopped being reported on its 30th day,
// with no flag, no audit row and nothing on any screen to say it had gone.
//
// It was found on 2026-08-26 when Mark watched three July 27 alerts vanish
// mid-session — he opened the audit log, came back, and the sliding cutoff
// had crawled past them while he read. Nobody clicked anything.
//
// 🔴 THE ARGUMENT THAT SETTLED IT: no_show was the ONLY one of this queue's
// five alert types that expired. `unscheduled`, `double_logged` and
// `wrong_time` all run from `REVIEW_FLOOR` (below), and `cancelled` has no
// window at all. Removing the expiry did not invent a policy — it made the
// fifth alert behave like the four it is rendered beside.
//
// Mark's instruction, verbatim through Jacob: the alert stands "until the
// end of time". It ends when a human ACKNOWLEDGES it (which writes a
// 'no_show' flag) — never because the clock moved.
//
// ⚠️ IF YOU ARE TEMPTED TO PUT A WINDOW BACK for cost reasons, read
// `blockAlertLogFloor` below FIRST: the two queries are coupled, and
// narrowing one of them alone manufactures FALSE no-shows against real
// coaches. Bound it by paging the RESULT, not by hiding candidates.

import { and, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import { db } from "@/db";
import {
  hourLogs,
  programBlockCoachFlags,
  programScheduleBlockCoaches,
  programScheduleBlocks,
  programs,
  users,
} from "@/db/schema";
import { isLogScheduled } from "@/lib/coach-hour-log";
import { findOverlappingLogIds } from "@/lib/hour-log-overlap";
import { MAX_HOUR_LOG_DURATION_MS } from "@/lib/schemas/hour-log";
import { fetchHourLogRowsWithScheduleNotes } from "@/lib/reports/hour-log-fetch";
import type { NormalizedHourLogFilters } from "@/lib/reports/hour-log-filters";
import { pfaDayEnd, pfaDayStart, pfaWallClockAt } from "@/lib/timezone";
import type { NeedsReviewItem } from "@/app/admin/_components/needs-review-card";

/**
 * The instant a block first counts as a no-show: 8:00 AM Pacific on the
 * calendar day AFTER the block's end. Pure + deterministic so it can be
 * unit-tested against fixed UTC instants.
 *
 * `pfaDayEnd(blockEndAt)` is the next Pacific day's 00:00 (correct for any
 * time-of-day, including late-evening blocks); `pfaWallClockAt(.., 8, 0)`
 * then places 8:00 AM on that next day.
 */
export function noShowDueAt(blockEndAt: Date): Date {
  const nextDayMidnight = pfaDayEnd(blockEndAt);
  return pfaWallClockAt(nextDayMidnight, 8, 0);
}

export type CancelledAlert = {
  type: "cancelled";
  flagId: string;
  coachName: string | null;
  programName: string;
  startAt: Date;
  endAt: Date;
  note: string | null;
};

export type NoShowAlert = {
  type: "no_show";
  blockId: string;
  coachId: string;
  coachName: string | null;
  programName: string;
  startAt: Date;
  endAt: Date;
};

/**
 * The single horizon for the WHOLE needs-review queue — every alert type,
 * not just no-shows. A FIXED floor that predates the app, deliberately NOT
 * a sliding window: nothing in this queue may age out on its own.
 *
 * It exists at all only so the candidate scan has a lower bound the planner
 * can use. Moving it forward would start silently dropping alerts again,
 * which is the exact defect this constant was introduced to kill.
 */
export const REVIEW_FLOOR = pfaDayStart(new Date("2024-01-01T12:00:00Z"));

/**
 * The earliest instant a log could START and still overlap ANY of the given
 * blocks — the lower bound for the no-show derivation's log query.
 *
 * 🔴 WHY THIS IS DERIVED AND NOT A SECOND CONSTANT. The no-show check asks
 * "did this coach log anything matching this block?" by joining two separate
 * queries: the candidate BLOCKS, and the coach's LOGS. If the log query is
 * ever narrower than the block query, blocks whose matching log falls
 * outside it come back as no-shows **for coaches who did log them** — a
 * false accusation on a real person's accountability record, rendered with
 * full confidence and reachable by no type error. Two hand-maintained
 * constants drift; a bound derived FROM the block set cannot.
 *
 * Correctness: `isLogScheduled` is a half-open overlap, so a matching log
 * satisfies `log.end > block.start`, and `MAX_HOUR_LOG_DURATION_MS` caps
 * `log.end - log.start`. Therefore `log.start > block.start - MAX`, and no
 * log that could match any candidate can start before this instant.
 */
export function blockAlertLogFloor(
  blocks: { startAt: Date }[],
): Date | null {
  if (blocks.length === 0) return null;
  const earliestStart = Math.min(...blocks.map((b) => b.startAt.getTime()));
  return new Date(earliestStart - MAX_HOUR_LOG_DURATION_MS);
}

export async function fetchBlockAccountabilityAlerts(
  now: Date,
): Promise<{ cancelled: CancelledAlert[]; noShow: NoShowAlert[] }> {

  // --- cancelled: stored, unresolved 'cancelled' flags ---
  const cancelledRows = await db
    .select({
      flagId: programBlockCoachFlags.id,
      note: programBlockCoachFlags.note,
      startAt: programScheduleBlocks.startAt,
      endAt: programScheduleBlocks.endAt,
      programName: programs.name,
      coachName: users.name,
      coachEmail: users.email,
    })
    .from(programBlockCoachFlags)
    .innerJoin(
      programScheduleBlocks,
      eq(programScheduleBlocks.id, programBlockCoachFlags.blockId),
    )
    .innerJoin(programs, eq(programs.id, programScheduleBlocks.programId))
    .innerJoin(users, eq(users.id, programBlockCoachFlags.coachId))
    .where(
      and(
        eq(programBlockCoachFlags.kind, "cancelled"),
        isNull(programBlockCoachFlags.reviewedAt),
      ),
    );

  const cancelled: CancelledAlert[] = cancelledRows.map((r) => ({
    type: "cancelled",
    flagId: r.flagId,
    coachName: r.coachName ?? r.coachEmail,
    programName: r.programName,
    startAt: r.startAt,
    endAt: r.endAt,
    note: r.note,
  }));

  // --- no_show: derived ---
  // 1. candidate (block, coach) pairs: blocks that have ENDED, within the
  //    lookback window, for every member coach. The per-block "is it due
  //    yet" threshold (8 AM Pacific the next day, via `noShowDueAt`) can't
  //    be a single SQL cutoff, so we fetch ended blocks here and filter the
  //    rows in JS below.
  const candidates = await db
    .select({
      blockId: programScheduleBlocks.id,
      programId: programScheduleBlocks.programId,
      programName: programs.name,
      coachId: programScheduleBlockCoaches.coachId,
      coachName: users.name,
      coachEmail: users.email,
      startAt: programScheduleBlocks.startAt,
      endAt: programScheduleBlocks.endAt,
    })
    .from(programScheduleBlocks)
    .innerJoin(
      programScheduleBlockCoaches,
      eq(programScheduleBlockCoaches.blockId, programScheduleBlocks.id),
    )
    .innerJoin(programs, eq(programs.id, programScheduleBlocks.programId))
    .innerJoin(users, eq(users.id, programScheduleBlockCoaches.coachId))
    .where(
      and(
        // 🔴 REVIEW_FLOOR, not a sliding cutoff. An unreviewed no-show is
        // reported until a human acknowledges it (see the file header).
        gte(programScheduleBlocks.endAt, REVIEW_FLOOR),
        lt(programScheduleBlocks.endAt, now),
      ),
    );

  if (candidates.length === 0) {
    return { cancelled, noShow: [] };
  }

  const coachIds = [...new Set(candidates.map((c) => c.coachId))];
  const blockIds = [...new Set(candidates.map((c) => c.blockId))];

  // 2. logs for these coaches, grouped by coach.
  //
  // 🔴 The floor is DERIVED FROM THE CANDIDATE BLOCKS, never from a constant
  // of its own. A log query narrower than the block query turns coaches who
  // DID log into no-shows. ▶ `blockAlertLogFloor`.
  const logFloor = blockAlertLogFloor(candidates);
  const logRows = await db
    .select({
      coachId: hourLogs.coachId,
      programId: hourLogs.programId,
      startAt: hourLogs.startAt,
      endAt: hourLogs.endAt,
    })
    .from(hourLogs)
    .where(
      and(
        // 1b security B: a held log must NOT suppress a no-show — it's not
        // yet a real log until an admin approves it.
        eq(hourLogs.status, "posted"),
        inArray(hourLogs.coachId, coachIds),
        ...(logFloor ? [gte(hourLogs.startAt, logFloor)] : []),
      ),
    );

  const logsByCoach = new Map<
    string,
    { programId: string; startMs: number; endMs: number }[]
  >();
  for (const log of logRows) {
    const list = logsByCoach.get(log.coachId) ?? [];
    list.push({
      programId: log.programId,
      startMs: log.startAt.getTime(),
      endMs: log.endAt.getTime(),
    });
    logsByCoach.set(log.coachId, list);
  }

  // 3. existing flags for these blocks — both kinds suppress a no-show.
  const flagRows = await db
    .select({
      blockId: programBlockCoachFlags.blockId,
      coachId: programBlockCoachFlags.coachId,
      kind: programBlockCoachFlags.kind,
    })
    .from(programBlockCoachFlags)
    .where(inArray(programBlockCoachFlags.blockId, blockIds));

  const cancelledKeys = new Set<string>();
  const noShowKeys = new Set<string>();
  for (const f of flagRows) {
    const key = `${f.blockId}:${f.coachId}`;
    if (f.kind === "cancelled") cancelledKeys.add(key);
    else if (f.kind === "no_show") noShowKeys.add(key);
  }

  const noShow: NoShowAlert[] = [];
  const nowMs = now.getTime();
  for (const c of candidates) {
    // Per-block threshold: a block isn't a no-show until 8 AM Pacific the
    // day after it ended. Until then, skip it (the coach may still log).
    if (nowMs < noShowDueAt(c.endAt).getTime()) continue;
    const key = `${c.blockId}:${c.coachId}`;
    if (cancelledKeys.has(key) || noShowKeys.has(key)) continue;
    const scheduled = isLogScheduled(
      {
        programId: c.programId,
        startMs: c.startAt.getTime(),
        endMs: c.endAt.getTime(),
      },
      logsByCoach.get(c.coachId) ?? [],
    );
    if (scheduled) continue;
    noShow.push({
      type: "no_show",
      blockId: c.blockId,
      coachId: c.coachId,
      coachName: c.coachName ?? c.coachEmail,
      programName: c.programName,
      startAt: c.startAt,
      endAt: c.endAt,
    });
  }

  return { cancelled, noShow };
}

/**
 * Per-coach no-show COUNT over a `sinceDays` (default 90) lookback, for the
 * Coach Accountability scorecard. Mirrors `fetchBlockAccountabilityAlerts`'s
 * no-show derivation (same tables/joins, same `noShowDueAt` + `isLogScheduled`
 * helpers) with TWO differences:
 *   • lookback is `sinceDays` (90), not the queue's hardcoded 30; and
 *   • it COUNTS already-acknowledged no_show flags — an acknowledged no-show
 *     still happened, so unlike the queue we do NOT suppress on existing
 *     no_show flags. CANCELLED flags still suppress (the coach told us in
 *     advance), exactly as in the queue.
 *
 * Returns coachId → count (coaches with zero no-shows are simply absent).
 */
export async function countNoShowsByCoach(
  now: Date,
  sinceDays = 90,
): Promise<Map<string, number>> {
  const windowStart = new Date(now.getTime() - sinceDays * 24 * 60 * 60_000);

  // Candidate (block, member-coach) pairs: blocks that have ENDED within the
  // window, for every member coach. Same fetch as the queue.
  const candidates = await db
    .select({
      blockId: programScheduleBlocks.id,
      programId: programScheduleBlocks.programId,
      coachId: programScheduleBlockCoaches.coachId,
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
        gte(programScheduleBlocks.endAt, windowStart),
        lt(programScheduleBlocks.endAt, now),
      ),
    );

  const counts = new Map<string, number>();
  if (candidates.length === 0) return counts;

  const coachIds = [...new Set(candidates.map((c) => c.coachId))];
  const blockIds = [...new Set(candidates.map((c) => c.blockId))];

  // Logs for these coaches within the window, grouped by coach.
  const logRows = await db
    .select({
      coachId: hourLogs.coachId,
      programId: hourLogs.programId,
      startAt: hourLogs.startAt,
      endAt: hourLogs.endAt,
    })
    .from(hourLogs)
    .where(
      and(
        // 1b security B: held logs don't feed the scorecard late/over-logged
        // signal — only approved (posted) logs count.
        eq(hourLogs.status, "posted"),
        inArray(hourLogs.coachId, coachIds),
        gte(hourLogs.startAt, windowStart),
      ),
    );

  const logsByCoach = new Map<
    string,
    { programId: string; startMs: number; endMs: number }[]
  >();
  for (const log of logRows) {
    const list = logsByCoach.get(log.coachId) ?? [];
    list.push({
      programId: log.programId,
      startMs: log.startAt.getTime(),
      endMs: log.endAt.getTime(),
    });
    logsByCoach.set(log.coachId, list);
  }

  // Only CANCELLED flags suppress a no-show here (unlike the queue, an acked
  // no_show flag does NOT — it still counts as a no-show that happened).
  const flagRows = await db
    .select({
      blockId: programBlockCoachFlags.blockId,
      coachId: programBlockCoachFlags.coachId,
      kind: programBlockCoachFlags.kind,
    })
    .from(programBlockCoachFlags)
    .where(inArray(programBlockCoachFlags.blockId, blockIds));

  const cancelledKeys = new Set<string>();
  for (const f of flagRows) {
    if (f.kind === "cancelled") {
      cancelledKeys.add(`${f.blockId}:${f.coachId}`);
    }
  }

  const nowMs = now.getTime();
  for (const c of candidates) {
    if (nowMs < noShowDueAt(c.endAt).getTime()) continue;
    if (cancelledKeys.has(`${c.blockId}:${c.coachId}`)) continue;
    const scheduled = isLogScheduled(
      {
        programId: c.programId,
        startMs: c.startAt.getTime(),
        endMs: c.endAt.getTime(),
      },
      logsByCoach.get(c.coachId) ?? [],
    );
    if (scheduled) continue;
    counts.set(c.coachId, (counts.get(c.coachId) ?? 0) + 1);
  }

  return counts;
}

/**
 * The full merged admin "Needs review" queue, newest-first (startAt desc).
 * Combines the hour-log-derived alerts (unscheduled / double_logged /
 * wrong_time, from `fetchHourLogRowsWithScheduleNotes`) with the
 * block-accountability alerts (cancelled + no_show, from
 * `fetchBlockAccountabilityAlerts`). Shared by the admin Home dashboard and
 * the admin Work Log page so the merge logic lives in exactly one place.
 *
 * The hour-log review window is the FULL backlog of still-unreviewed rows
 * (a fixed floor that predates the app through today's PFA end, no
 * coach/program narrowing) — identical to what Home passed inline.
 */
export async function fetchNeedsReviewItems(
  now: Date,
): Promise<NeedsReviewItem[]> {
  // The SAME floor the block-accountability half uses — one horizon for the
  // whole queue, so no alert type can quietly acquire a shorter memory than
  // the ones rendered beside it.
  const reviewFloor = REVIEW_FLOOR;
  const reviewCeiling = pfaDayEnd(now);
  const reviewFilter: NormalizedHourLogFilters = {
    from: "2024-01-01",
    to: "2024-01-01",
    fromDate: reviewFloor,
    toDateExclusive: reviewCeiling,
    // Empty = no coach predicate: the review backlog spans every coach.
    coachIds: [],
    programId: undefined,
    isFiltered: true,
  };

  const [reviewWindowRows, blockAlerts] = await Promise.all([
    fetchHourLogRowsWithScheduleNotes(reviewFilter),
    fetchBlockAccountabilityAlerts(now),
  ]);

  // Bucket each UNREVIEWED row into exactly one hour-log alert type, by
  // priority, so no log shows under two tags:
  //   • unscheduled — logged program hours with no matching block
  //   • double_logged — a non-unscheduled log overlapping ANOTHER log of the
  //     same coach (double-pay / duplicate-entry risk)
  //   • wrong_time — a non-unscheduled, non-overlapping log that
  //     reconciliation flagged with a scheduleNote
  const reviewable = reviewWindowRows.filter((r) => !r.reviewedAt);
  const unscheduledRows = reviewable.filter((r) => r.unscheduled);
  const rest = reviewable.filter((r) => !r.unscheduled);
  const doubleIds = findOverlappingLogIds(
    reviewable.map((r) => ({
      id: r.id,
      coachId: r.coachId,
      startMs: r.startAt.getTime(),
      endMs: r.endAt.getTime(),
    })),
  );
  const doubleRows = rest.filter((r) => doubleIds.has(r.id));
  const wrongTimeRows = rest.filter(
    (r) => !doubleIds.has(r.id) && r.scheduleNote,
  );

  return [
    ...unscheduledRows.map((r) => ({
      type: "unscheduled" as const,
      id: r.id,
      coachName: r.coachName,
      programName: r.programName,
      startAt: r.startAt,
      endAt: r.endAt,
    })),
    ...doubleRows.map((r) => ({
      type: "double_logged" as const,
      id: r.id,
      coachName: r.coachName,
      programName: r.programName,
      startAt: r.startAt,
      endAt: r.endAt,
    })),
    ...wrongTimeRows.map((r) => ({
      type: "wrong_time" as const,
      id: r.id,
      coachName: r.coachName,
      programName: r.programName,
      startAt: r.startAt,
      endAt: r.endAt,
      detail: r.scheduleNote,
    })),
    ...blockAlerts.cancelled,
    ...blockAlerts.noShow,
  ].sort((a, b) => b.startAt.getTime() - a.startAt.getTime());
}
