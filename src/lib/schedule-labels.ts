// `0q` — the WORDS every pay surface uses for a log that is NOT ON THE SCHEDULE.
//
// 🔴 ONE definition, imported by the Work tab (`work-preview.tsx`), the reports
// workbook (`reports/excel.ts`) and the hour-log workbook
// (`reports/hour-log-excel.ts`). Zero runtime imports, so a client component
// and a spreadsheet builder can both take it (precedent: `stipend/labels.ts`).
// The review DATE therefore arrives already formatted (PFA YYYY-MM-DD, via
// `formatPfaDate` in the caller) rather than as a Date this module would have
// to format itself.
//
// ── Why this exists ──────────────────────────────────────────────────────
// Sept 13 2026: the Work tab Mark pays from showed **$900 against $500–600
// correct**. Coaches had logged hours on schedule blocks, the blocks were then
// deleted, and the logs stayed posted and paid. That part is by design — a
// deleted block is a statement about the PLAN, the log is the record of WORK —
// but the pay report rendered a row with NO block exactly like a row that
// matched its block perfectly: the reconciliation note is null in both cases,
// so both Schedule cells were blank. Nothing on the screen said "look here".
//
// ── What the words may and may not say ───────────────────────────────────
// The mark is a fact about the SCHEDULE ("Not on schedule"), never a verdict
// about PAY. Most such rows are legitimate (covers, cleaning, games nobody put
// on the schedule) and Mark approves them; "do not pay" / "unpaid" would be
// false on most of the rows it appeared on. Pay is decided by Accept / Reject
// on the Work Log, and this module never changes a figure.
//
// ── 🔴 A reviewed row is NOT "accepted as off-schedule" ──────────────────
// `reviewedAt` is stamped by admin hour entry at insert, by approving a held
// log, and by queue Accept on rows that were ON a block at the time (wrong
// time, double-logged). So "Mark records 2h on a block, later someone deletes
// the block" produces a reviewed row that nobody ever judged off-schedule —
// the exact 0q case. Jacob, 2026-10-14: EVERY left-behind row reads "Not on
// schedule" in the same loud way; a reviewed one only adds WHEN it was
// reviewed. Nothing left behind may look quieter than anything else.
//
// ── Rejected rows (the hour-log workbook only) ───────────────────────────
// That workbook lists rejected rows beside paid ones. Once some rejected rows
// say "Rejected", a blank would read as "not rejected", so EVERY rejected
// row's cell starts with it — on the schedule or off.

/** The one wording, everywhere an admin pays from. */
export const NOT_ON_SCHEDULE_LABEL = "Not on schedule";

const REJECTED_LABEL = "Rejected";

/** "reviewed 2026-10-03" — the line under the pill on screen. */
export function reviewedOnText(reviewedOn: string): string {
  return `reviewed ${reviewedOn}`;
}

/**
 * A spreadsheet "Schedule" cell, in one string so a reader who sorts or
 * filters the sheet never separates the mark from its row:
 *
 *   rejected  → "Rejected", then "; Not on schedule" if off the schedule
 *               (no review date: rejecting stamps it, and "Rejected" says it)
 *   otherwise → "Not on schedule" (+ " (reviewed <date>)") if off the schedule
 *   then "; <note>" whenever the reconciliation note exists.
 *
 * A scheduled, non-rejected row is just its note, or "" — a review date alone
 * prints nothing.
 *
 * @param row.reviewedOn PFA date of `reviewedAt`, already formatted, for a
 *   POSTED row; pass null for anything else.
 */
export function scheduleCellText(row: {
  status: "posted" | "held" | "rejected";
  unscheduled: boolean;
  reviewedOn: string | null;
  scheduleNote: string | null;
}): string {
  const parts: string[] = [];
  if (row.status === "rejected") {
    parts.push(REJECTED_LABEL);
    if (row.unscheduled) parts.push(NOT_ON_SCHEDULE_LABEL);
  } else if (row.unscheduled) {
    parts.push(
      row.reviewedOn
        ? `${NOT_ON_SCHEDULE_LABEL} (${reviewedOnText(row.reviewedOn)})`
        : NOT_ON_SCHEDULE_LABEL,
    );
  }
  if (row.scheduleNote) parts.push(row.scheduleNote);
  return parts.join("; ");
}
