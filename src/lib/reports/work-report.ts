// Pure shaping for the Reports "Work hours" tab (reports-tabs SPEC §3,
// tab 2). No DB, no React, no I/O — the page fetches rows, this turns
// them into what the screen and (Phase E) the workbook render.
//
// ── Why summary and detail are built from ONE row set ────────────────────
// The obvious build — detail from `fetchHourLogRows`, summary from
// `aggregateReport` — does not reconcile. The two queries disagree on
// REJECTED logs (`fetchReportData` pins status='posted';
// `fetchHourLogRows` returns 'posted' + 'rejected' so the admin Work Log
// table can badge them). Wire those two together and the rows on screen
// visibly fail to add up to the total above them, which on a payroll
// screen reads as broken money. So both come from the same array here:
// the detail rows ARE the summands, and the grand total is the sum of the
// detail rows. It cannot drift because there is nothing to drift from.
//
// ── Money direction ──────────────────────────────────────────────────────
// PFA OWES THE COACH. The opposite of the cage receivable. Never summed
// with it (SPEC §7).
//
// ── Pay comes from ONE function ──────────────────────────────────────────
// `workPayForLog` — the shared read-side entry point that branches
// per-session vs hourly off the immutable snapshot. `aggregate.ts` and the
// "Owed to coaches" card call the same one. Never reimplement it.

import { programMinutes, workPayForLog } from "@/lib/billing";
import {
  formatPfaDate,
  formatPfaTime,
  formatPfaWeekday,
} from "@/lib/timezone";
import type { HourLogFetchRow } from "./hour-log-fetch";

/**
 * Statuses the Work tab reports on. POSTED ONLY, by decision:
 *
 * A rejected log is work an admin looked at and decided not to pay. It is
 * not owed, and Reports is the "what is owed" surface — so including it
 * would put a not-owed row inside a pay total, forcing every figure on the
 * page to carry an asterisk. Rejected logs keep their home on
 * /admin/hour-log, which shows them badged with the rejection reason; the
 * Work tab links there in a line of copy so their absence is never silent.
 *
 * Held logs are excluded upstream by `fetchHourLogRows` (not yet approved,
 * therefore not yet payable) — that predicate is unchanged.
 */
const REPORTED_STATUSES = new Set(["posted"]);

export type WorkDetailRow = {
  id: string;
  date: string; // YYYY-MM-DD, PFA time
  dayOfWeek: string; // "Mon"
  startTime: string; // "09:00"
  endTime: string; // "10:30"
  /** Exact fractional hours — a 45-min log is 0.75. */
  hours: number;
  programName: string;
  coachId: string;
  coachName: string; // display name; falls back to email
  coachEmail: string;
  /** Per-30-min snapshot, or null on a per-session / pre-rate log. */
  ratePer30MinCents: number | null;
  /** Flat per-session snapshot, or null when the log is hourly. */
  perSessionRateCents: number | null;
  /** What this single log pays. From workPayForLog — never recomputed. */
  payCents: number;
  note: string | null;
  scheduleNote: string | null;
};

export type WorkSummaryRow = {
  coachId: string;
  coachName: string;
  coachEmail: string;
  /** How many logs rolled into this row — lets a reader tie back to detail. */
  entries: number;
  hours: number;
  payCents: number;
};

export type WorkReportData = {
  detail: WorkDetailRow[];
  summary: WorkSummaryRow[];
  /** PFA owes coaches. NEVER summed with the cage receivable. */
  grandTotalCents: number;
  /** Sum of `hours` across every detail row. */
  grandTotalHours: number;
};

/**
 * Turns fetched hour-log rows into the Work tab's shape.
 *
 * Detail keeps the fetch's order (coach name, then start). Summary is
 * sorted by coach name to match the cage tab and the workbook.
 */
export function buildWorkReport(rows: HourLogFetchRow[]): WorkReportData {
  const detail: WorkDetailRow[] = rows
    .filter((r) => REPORTED_STATUSES.has(r.status))
    .map((r) => ({
      id: r.id,
      date: formatPfaDate(r.startAt),
      dayOfWeek: formatPfaWeekday(r.startAt),
      startTime: formatPfaTime(r.startAt),
      endTime: formatPfaTime(r.endAt),
      hours: programMinutes(r.startAt, r.endAt) / 60,
      programName: r.programName,
      coachId: r.coachId,
      coachName: r.coachName ?? r.coachEmail,
      coachEmail: r.coachEmail,
      ratePer30MinCents: r.ratePer30MinCents,
      perSessionRateCents: r.perSessionRateCents,
      payCents: workPayForLog({
        perSessionRateCents: r.perSessionRateCents,
        startAt: r.startAt,
        endAt: r.endAt,
        ratePer30MinCents: r.ratePer30MinCents,
      }),
      note: r.note,
      scheduleNote: r.scheduleNote,
    }));

  // Roll the SAME rows up per coach — the summary is a view of the detail,
  // not a second query, so the two always agree.
  const summaryMap = new Map<string, WorkSummaryRow>();
  for (const row of detail) {
    let entry = summaryMap.get(row.coachId);
    if (!entry) {
      entry = {
        coachId: row.coachId,
        coachName: row.coachName,
        coachEmail: row.coachEmail,
        entries: 0,
        hours: 0,
        payCents: 0,
      };
      summaryMap.set(row.coachId, entry);
    }
    entry.entries += 1;
    entry.hours += row.hours;
    entry.payCents += row.payCents;
  }

  const summary = Array.from(summaryMap.values()).sort((a, b) =>
    a.coachName.localeCompare(b.coachName),
  );

  return {
    detail,
    summary,
    grandTotalCents: detail.reduce((sum, r) => sum + r.payCents, 0),
    grandTotalHours: detail.reduce((sum, r) => sum + r.hours, 0),
  };
}
