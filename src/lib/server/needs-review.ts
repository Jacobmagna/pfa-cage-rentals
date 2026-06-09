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
// Everything is bounded to a 30-day lookback window so the derivation stays
// cheap and the queue never grows without bound.

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
import { fetchHourLogRowsWithScheduleNotes } from "@/lib/reports/hour-log-fetch";
import type { NormalizedHourLogFilters } from "@/lib/reports/hour-log-filters";
import { pfaDayEnd, pfaDayStart, pfaWallClockAt } from "@/lib/timezone";
import type { NeedsReviewItem } from "@/app/admin/_components/needs-review-card";

/**
 * The instant a block first counts as a no-show: 8:00 AM Pacific on the
 * calendar day AFTER the block's end. Pure + deterministic so it can be
 * unit-tested against fixed UTC instants.
 *
 * We anchor on `pfaDayStart(blockEndAt)` (PFA midnight of the block's own
 * Pacific day) BEFORE calling `pfaDayEnd`: pfaDayEnd's "+25h then snap"
 * trick over-shoots by a day for late-evening Pacific inputs (e.g. an
 * 11:30 PM block), so feeding it the day-start (a near-midnight instant)
 * keeps the +25h safely inside the next Pacific day. `pfaWallClockAt` then
 * places 8:00 AM on that next day.
 */
export function noShowDueAt(blockEndAt: Date): Date {
  const nextDayMidnight = pfaDayEnd(pfaDayStart(blockEndAt));
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

const LOOKBACK_MS = 30 * 24 * 60 * 60_000;

export async function fetchBlockAccountabilityAlerts(
  now: Date,
): Promise<{ cancelled: CancelledAlert[]; noShow: NoShowAlert[] }> {
  const windowStart = new Date(now.getTime() - LOOKBACK_MS);

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
        gte(programScheduleBlocks.endAt, windowStart),
        lt(programScheduleBlocks.endAt, now),
      ),
    );

  if (candidates.length === 0) {
    return { cancelled, noShow: [] };
  }

  const coachIds = [...new Set(candidates.map((c) => c.coachId))];
  const blockIds = [...new Set(candidates.map((c) => c.blockId))];

  // 2. logs for these coaches within the window, grouped by coach.
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
  const reviewFloor = pfaDayStart(new Date("2024-01-01T12:00:00Z"));
  const reviewCeiling = pfaDayEnd(now);
  const reviewFilter: NormalizedHourLogFilters = {
    from: "2024-01-01",
    to: "2024-01-01",
    fromDate: reviewFloor,
    toDateExclusive: reviewCeiling,
    coachId: undefined,
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
