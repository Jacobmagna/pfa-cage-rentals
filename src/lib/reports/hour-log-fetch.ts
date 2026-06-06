// Shared data-fetch for /admin/hour-log and its download route — the
// page preview and the downloaded workbook must show identical rows.
// Mirrors lib/reports/fetch.ts: takes the normalized filter shape, runs
// the JOIN, returns plain rows. No Next-specific imports, so the route
// handler and the server component both call it.
//
// JOINs are inner — a row can't exist without a coach + program FK
// target. Filtered by the date range (startAt within [fromDate,
// toDateExclusive)) plus the optional single coach / program. Ordered
// by coach name then start so the table reads grouped-by-coach.

import { and, asc, eq, gt, gte, inArray, lt } from "drizzle-orm";
import { db } from "@/db";
import {
  hourLogs,
  programScheduleBlockCoaches,
  programScheduleBlocks,
  programs,
  users,
} from "@/db/schema";
import { isLogScheduled } from "@/lib/coach-hour-log";
import {
  annotateLogs,
  type ReconBlock,
  type ReconCoach,
  type ReconLog,
} from "@/lib/server/reconciliation";
import { formatPfaTime12h } from "@/lib/timezone";
import type { HourLogWorkbookRow } from "./hour-log-excel";
import type { NormalizedHourLogFilters } from "./hour-log-filters";

export async function fetchHourLogRows(
  filters: NormalizedHourLogFilters,
): Promise<HourLogWorkbookRow[]> {
  const conditions = [
    gte(hourLogs.startAt, filters.fromDate),
    lt(hourLogs.startAt, filters.toDateExclusive),
  ];
  if (filters.coachId) {
    conditions.push(eq(hourLogs.coachId, filters.coachId));
  }
  if (filters.programId) {
    conditions.push(eq(hourLogs.programId, filters.programId));
  }

  const rows = await db
    .select({
      id: hourLogs.id,
      coachId: hourLogs.coachId,
      coachName: users.name,
      coachEmail: users.email,
      programId: hourLogs.programId,
      programName: programs.name,
      startAt: hourLogs.startAt,
      endAt: hourLogs.endAt,
      note: hourLogs.note,
      reviewedAt: hourLogs.reviewedAt,
      reviewedBy: hourLogs.reviewedBy,
    })
    .from(hourLogs)
    .innerJoin(users, eq(hourLogs.coachId, users.id))
    .innerJoin(programs, eq(hourLogs.programId, programs.id))
    .where(and(...conditions))
    .orderBy(asc(users.name), asc(hourLogs.startAt));

  // Base rows carry no schedule note — the annotate wrapper fills it.
  return rows.map((r) => ({ ...r, scheduleNote: null }));
}

/**
 * Same rows as fetchHourLogRows, but with each row's `scheduleNote`
 * filled from the pure reconciliation engine (FEAT-16, DEC-30). Both the
 * page table preview and the downloaded workbook call this so they show
 * identical notes. Row order is preserved.
 */
export async function fetchHourLogRowsWithScheduleNotes(
  filters: NormalizedHourLogFilters,
): Promise<HourLogWorkbookRow[]> {
  const rows = await fetchHourLogRows(filters);

  // Scheduled blocks overlapping the same window as the logs. Overlap =
  // block starts before the range ends AND ends after the range starts.
  const blockRows = await db
    .select({
      id: programScheduleBlocks.id,
      programId: programScheduleBlocks.programId,
      scheduledCoachId: programScheduleBlocks.scheduledCoachId,
      coachName: users.name,
      coachEmail: users.email,
      startAt: programScheduleBlocks.startAt,
      endAt: programScheduleBlocks.endAt,
    })
    .from(programScheduleBlocks)
    .innerJoin(users, eq(programScheduleBlocks.scheduledCoachId, users.id))
    .where(
      and(
        lt(programScheduleBlocks.startAt, filters.toDateExclusive),
        gt(programScheduleBlocks.endAt, filters.fromDate),
      ),
    );

  // QA10 W3.2: the full scheduled-coach set per block, grouped by block
  // (primary first), so annotateLogs treats every scheduled coach as
  // "in set" rather than only the primary.
  const blockIds = blockRows.map((b) => b.id);
  const blockCoachRows =
    blockIds.length > 0
      ? await db
          .select({
            blockId: programScheduleBlockCoaches.blockId,
            coachId: programScheduleBlockCoaches.coachId,
            coachName: users.name,
            coachEmail: users.email,
          })
          .from(programScheduleBlockCoaches)
          .innerJoin(users, eq(programScheduleBlockCoaches.coachId, users.id))
          .where(inArray(programScheduleBlockCoaches.blockId, blockIds))
      : [];
  const coachesByBlock = new Map<string, ReconCoach[]>();
  for (const r of blockCoachRows) {
    const list = coachesByBlock.get(r.blockId) ?? [];
    list.push({ coachId: r.coachId, coachName: r.coachName ?? r.coachEmail });
    coachesByBlock.set(r.blockId, list);
  }

  const blocks: ReconBlock[] = blockRows.map((b) => {
    const primary = {
      coachId: b.scheduledCoachId,
      coachName: b.coachName ?? b.coachEmail,
    };
    const list = coachesByBlock.get(b.id);
    const coaches =
      !list || list.length === 0
        ? [primary]
        : [primary, ...list.filter((c) => c.coachId !== b.scheduledCoachId)];
    return {
      id: b.id,
      programId: b.programId,
      scheduledCoachId: b.scheduledCoachId,
      scheduledCoachName: b.coachName ?? b.coachEmail,
      coaches,
      startAt: b.startAt,
      endAt: b.endAt,
    };
  });

  const logs: (ReconLog & { id: string })[] = rows.map((r) => ({
    id: r.id,
    coachId: r.coachId,
    coachName: r.coachName ?? r.coachEmail,
    programId: r.programId,
    startAt: r.startAt,
    endAt: r.endAt,
  }));

  const notes = annotateLogs({ logs, blocks }, formatPfaTime12h);

  // QA10 W3-polish13a: per-coach "unscheduled" flag. A log is unscheduled
  // iff NO block the log's coach is a MEMBER of (block.coaches) overlaps it
  // for the same program — the exact rule the coach History page uses, NOT
  // reconciliation's wrong_coach. Reuse the in-memory `blocks` membership
  // sets: group each coach's membership blocks once, then test via the
  // shared isLogScheduled helper.
  const membershipByCoach = new Map<
    string,
    { programId: string; startMs: number; endMs: number }[]
  >();
  for (const b of blocks) {
    const startMs = b.startAt.getTime();
    const endMs = b.endAt.getTime();
    for (const c of b.coaches) {
      const list = membershipByCoach.get(c.coachId) ?? [];
      list.push({ programId: b.programId, startMs, endMs });
      membershipByCoach.set(c.coachId, list);
    }
  }

  return rows.map((r) => ({
    ...r,
    scheduleNote: notes[r.id] ?? null,
    unscheduled: !isLogScheduled(
      {
        programId: r.programId,
        startMs: r.startAt.getTime(),
        endMs: r.endAt.getTime(),
      },
      membershipByCoach.get(r.coachId) ?? [],
    ),
  }));
}
