// Shared data-fetch for /admin/hour-log and its download route — the
// page preview and the downloaded workbook must show identical rows.
// Mirrors lib/reports/fetch.ts: takes the normalized filter shape, runs
// the JOIN, returns plain rows. No Next-specific imports, so the route
// handler and the server component both call it.
//
// JOINs are inner — a row can't exist without a coach + program FK
// target. Filtered by the date range (startAt within [fromDate,
// toDateExclusive)) plus the optional coach set / program. Ordered
// by coach name then start so the table reads grouped-by-coach.

import { and, asc, eq, gt, gte, inArray, lt, type SQL } from "drizzle-orm";
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

// The admin Work Log fetch carries the per-log review decision so the table
// can badge rejected rows. These columns aren't part of the downloadable
// workbook shape (HourLogWorkbookRow), so we widen the return type here
// rather than in the Excel builder. `status` is always present; `decisionReason`
// is the coach-visible reject note (null unless rejected).
export type HourLogFetchRow = HourLogWorkbookRow & {
  status: "posted" | "held" | "rejected";
  decisionReason: string | null;
  /**
   * The immutable pay snapshots stamped on the log at write time
   * (`hour-log-actions.ts`). Added for the Reports "Work hours" tab, which
   * needs per-row pay — this fetch previously carried HOURS ONLY, so
   * `buildHourLogWorkbook` and the admin Work Log table have no money in
   * them at all.
   *
   * NEVER compute pay from these directly. Feed them to `workPayForLog`
   * (`@/lib/billing`), the single read-side entry point that branches
   * per-session vs hourly — the same function `aggregate.ts` and the
   * "Owed to coaches" card already call. Two implementations of this
   * figure is the drift the reports-tabs SPEC §2 warns about.
   *
   * Both are NULLABLE: a pre-rate log carries neither and pays $0.
   */
  ratePer30MinCents: number | null;
  /**
   * 🔴 The log's own write-time snapshot: a stipend covered this work, so it
   * pays $0 BY DECISION rather than for want of a rate. Every rate cell must
   * say "Covered by stipend" instead of "No rate" — see SPEC §10.3.
   */
  stipendCovered: boolean;
  perSessionRateCents: number | null;
};

/**
 * The WHERE conditions for the hour-log row query. Exported so a unit
 * test can assert the emitted SQL directly — in particular that an EMPTY
 * `coachIds` emits NO coach predicate at all (an `IN ()` would be invalid
 * SQL, and some drivers silently match nothing).
 */
export function hourLogRowConditions(
  filters: NormalizedHourLogFilters,
): SQL[] {
  const conditions: SQL[] = [
    // 1b security B: exclude held (awaiting-approval) logs from the admin
    // Work Log table + workbook — they're not real logs until approved.
    // Rejected logs ARE included so the admin table can SHOW them with a
    // "Rejected" badge; they carry reviewedAt so they never re-surface as
    // open needs-review items, and pay/aggregate reads pin status='posted'
    // elsewhere so they're never billed.
    inArray(hourLogs.status, ["posted", "rejected"]),
    gte(hourLogs.startAt, filters.fromDate),
    lt(hourLogs.startAt, filters.toDateExclusive),
  ];
  // Empty set = "all coaches": push nothing, so the query carries no
  // coach predicate. One id behaves identically to the previous
  // `eq(coachId, x)` — `IN ($1)` selects the same rows in the same order.
  if (filters.coachIds.length > 0) {
    conditions.push(inArray(hourLogs.coachId, filters.coachIds));
  }
  if (filters.programId) {
    conditions.push(eq(hourLogs.programId, filters.programId));
  }
  return conditions;
}

export async function fetchHourLogRows(
  filters: NormalizedHourLogFilters,
): Promise<HourLogFetchRow[]> {
  const conditions = hourLogRowConditions(filters);

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
      status: hourLogs.status,
      decisionReason: hourLogs.decisionReason,
      ratePer30MinCents: hourLogs.ratePer30MinCents,
      stipendCovered: hourLogs.stipendCovered,
      perSessionRateCents: hourLogs.perSessionRateCents,
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
): Promise<HourLogFetchRow[]> {
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
    // QA-R2 #10: LEFT join so coachless (Unassigned) blocks still appear;
    // coachName/coachEmail are null for them.
    .leftJoin(users, eq(programScheduleBlocks.scheduledCoachId, users.id))
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
    // QA-R2 #10: a coachless (Unassigned) block has no primary and an
    // empty coach set, so reconciliation yields no per-coach rows for it.
    const primary =
      b.scheduledCoachId !== null
        ? {
            coachId: b.scheduledCoachId,
            coachName: b.coachName ?? b.coachEmail ?? b.scheduledCoachId,
          }
        : null;
    const list = coachesByBlock.get(b.id);
    const coaches =
      primary === null
        ? (list ?? [])
        : !list || list.length === 0
          ? [primary]
          : [primary, ...list.filter((c) => c.coachId !== b.scheduledCoachId)];
    return {
      id: b.id,
      programId: b.programId,
      scheduledCoachId: b.scheduledCoachId,
      scheduledCoachName: primary?.coachName ?? null,
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
