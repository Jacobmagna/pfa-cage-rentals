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
import { payPeriodFor, payPeriodLabel } from "@/lib/pay-period";
import type { StipendEarningRow } from "@/lib/stipend/fetch";
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

/**
 * 🔴 A detail row is now one of TWO things, and the discriminant is REQUIRED
 * so the compiler enumerates every renderer that has to tell them apart
 * (discipline rule 16 — a required field is a better audit than a grep).
 *
 *  - "log"     — an hour log, exactly as before.
 *  - "stipend" — a flat half-month amount. It has NO times, NO hours and NO
 *    rate, and every one of those renders as an em dash rather than a zero.
 *
 * ⚠️ Stipends are detail ROWS, not a total-only adjustment, and that is
 * non-negotiable (SPEC §10.3). This module's whole contract is *"the detail
 * rows ARE the summands, and the grand total is the sum of the detail rows."*
 * A stipend added to the total but not shown would produce exactly the failure
 * that sentence exists to prevent: rows on screen that visibly fail to add up
 * to the total above them, which on a payroll screen reads as broken money.
 */
export type WorkDetailKind = "log" | "stipend";

export type WorkDetailRow = {
  kind: WorkDetailKind;
  id: string;
  date: string; // YYYY-MM-DD, PFA time
  /** null on a stipend — it is a period, not a day. */
  dayOfWeek: string | null;
  /** null on a stipend — it has no clock times. Renders as an em dash. */
  startTime: string | null;
  endTime: string | null;
  /**
   * Exact fractional hours — a 45-min log is 0.75.
   *
   * ⚠️ A stipend is `0`, and that is THE ONE HONEST ZERO in this feature: a
   * stipend genuinely has no hours. It must still render as an em dash, never
   * as "0.0 h", which would read as "worked nothing, paid $2,500".
   */
  hours: number;
  /**
   * 🔴 True on a LOG whose pay is $0 because a stipend already covers it.
   * Renderers must say "Covered by stipend" rather than "No rate" — Mark's
   * whole ask is to see 72 real hours AND see they are deliberately not
   * being charged. "No rate" beside 72 hours reads as a misconfiguration.
   */
  stipendCovered: boolean;
  /** "Aug 1–15, 2026" on a stipend; null on a log. */
  periodLabel: string | null;
  /**
   * 🔴 The stipend's own period bounds, as real instants. Null on a log.
   *
   * The statement engine buckets a charge by `startAt.getTime()`, so a stipend
   * needs a genuine Date, not the `date` display string re-parsed. Re-parsing
   * a formatted date is how a PFA-vs-UTC misbucket gets reintroduced — the
   * exact class of bug that has bitten this repo twice.
   */
  periodStart: Date | null;
  periodEndExclusive: Date | null;
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
 * Turns fetched hour-log rows (and any earned stipends in scope) into the
 * Work tab's shape.
 *
 * Detail keeps the fetch's order (coach name, then start), with stipend rows
 * appended and sorted by period. Summary is sorted by coach name to match the
 * cage tab and the workbook.
 *
 * @param stipendEarnings already scoped by the caller — this function does no
 *   filtering of its own. `fetchStipendEarningsInRange` applies the overlap
 *   rule; passing nothing keeps behaviour byte-identical to before stipends
 *   existed, which is what lets every existing caller and test stay unchanged.
 */
export function buildWorkReport(
  rows: HourLogFetchRow[],
  stipendEarnings: StipendEarningRow[] = [],
): WorkReportData {
  const detail: WorkDetailRow[] = rows
    .filter((r) => REPORTED_STATUSES.has(r.status))
    .map((r) => ({
      kind: "log" as const,
      id: r.id,
      date: formatPfaDate(r.startAt),
      dayOfWeek: formatPfaWeekday(r.startAt),
      startTime: formatPfaTime(r.startAt),
      endTime: formatPfaTime(r.endAt),
      hours: programMinutes(r.startAt, r.endAt) / 60,
      stipendCovered: r.stipendCovered,
      periodLabel: null,
      periodStart: null,
      periodEndExclusive: null,
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

  // A stipend earning carries only a coachId, so the display name comes from
  // whatever log rows are already in scope. ⚠️ A coach with a stipend and NO
  // logs in the range falls back to the id — visible and ugly on purpose,
  // rather than a blank cell that reads as a rendering bug. In practice it
  // cannot happen: an earning exists only because a covered log posted.
  const coachIdentity = new Map<string, { coachName: string; coachEmail: string }>();
  for (const r of rows) {
    coachIdentity.set(r.coachId, {
      coachName: r.coachName ?? r.coachEmail,
      coachEmail: r.coachEmail,
    });
  }

  // 🔴 Stipend rows join the SAME array the summary and the grand total are
  // computed from. There is deliberately no separate "stipendTotalCents" —
  // a second total is a second thing to drift.
  for (const e of stipendEarnings) {
    const period = payPeriodFor(e.periodStart);
    const coach = coachIdentity.get(e.coachId);
    detail.push({
      kind: "stipend",
      id: e.id,
      date: formatPfaDate(e.periodStart),
      dayOfWeek: null,
      startTime: null,
      endTime: null,
      hours: 0,
      stipendCovered: false,
      periodLabel: payPeriodLabel(period),
      periodStart: period.fromDate,
      periodEndExclusive: period.toDateExclusive,
      // The period label is IN the row, because §5.4 means two stipends can
      // land inside one filtered range and the reader must see why.
      programName: `Stipend — ${payPeriodLabel(period)}`,
      coachId: e.coachId,
      coachName: coach?.coachName ?? e.coachId,
      coachEmail: coach?.coachEmail ?? "",
      ratePer30MinCents: null,
      perSessionRateCents: null,
      payCents: e.amountCents,
      note: null,
      scheduleNote: null,
    });
  }

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
