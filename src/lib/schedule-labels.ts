// `0q` — the WORDS every pay surface uses for a log that is NOT ON THE SCHEDULE.
//
// 🔴 ONE definition, imported by the Work tab (`work-preview.tsx`), the reports
// workbook (`reports/excel.ts`) and the hour-log workbook
// (`reports/hour-log-excel.ts`). Zero runtime imports, so a client component
// and a spreadsheet builder can both take it (precedent: `stipend/labels.ts`).
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
// ── The three states ─────────────────────────────────────────────────────
//   unreviewed — posted, nobody has looked at it yet → loud (red on screen).
//   accepted   — posted AND reviewed (Mark pressed Accept) → quiet (gray).
//                Q5, 2026-10-14: 20 legitimate accepted rows would otherwise
//                sit red on the report forever.
//   rejected   — taken off pay; only the hour-log workbook lists these.
// 🔴 "accepted" keys on status === "posted" AND reviewedAt set. Rejecting a
// log ALSO stamps reviewedAt, so a rule on reviewedAt alone would print
// "accepted" beside work Mark turned down.

/** The one wording, everywhere an admin pays from. */
export const NOT_ON_SCHEDULE_LABEL = "Not on schedule";

export type NotOnScheduleState = "unreviewed" | "accepted" | "rejected";

/**
 * Which "not on schedule" state a log is in, or null when it IS on the
 * schedule. A held log (awaiting approval) has not been decided, so it reads
 * as unreviewed — never accepted.
 */
export function notOnScheduleState(row: {
  unscheduled: boolean;
  status: "posted" | "held" | "rejected";
  reviewedAt: Date | null;
}): NotOnScheduleState | null {
  if (!row.unscheduled) return null;
  if (row.status === "rejected") return "rejected";
  if (row.status === "posted" && row.reviewedAt != null) return "accepted";
  return "unreviewed";
}

/**
 * The same rule for a row already known to be POSTED — the pay report's rows
 * (`WorkDetailRow`), which carry `reviewed` (posted with reviewedAt set)
 * instead of the raw status and stamp. A rejected row never reaches the pay
 * report, so there is no rejected state here.
 */
export function postedRowScheduleState(row: {
  unscheduled: boolean;
  reviewed: boolean;
}): Exclude<NotOnScheduleState, "rejected"> | null {
  if (!row.unscheduled) return null;
  return row.reviewed ? "accepted" : "unreviewed";
}

/** "Not on schedule", "Not on schedule · accepted", "Not on schedule · rejected". */
export function notOnScheduleText(state: NotOnScheduleState): string {
  switch (state) {
    case "unreviewed":
      return NOT_ON_SCHEDULE_LABEL;
    case "accepted":
      return `${NOT_ON_SCHEDULE_LABEL} · accepted`;
    case "rejected":
      return `${NOT_ON_SCHEDULE_LABEL} · rejected`;
  }
}

/**
 * A spreadsheet "Schedule" cell: the label, then "; <note>" when the
 * reconciliation note also exists; just the note when the row is on the
 * schedule; "" when neither. One cell, so a reader who sorts or filters the
 * sheet never separates the mark from the row it belongs to.
 */
export function scheduleCellText(
  state: NotOnScheduleState | null,
  scheduleNote: string | null,
): string {
  if (state === null) return scheduleNote ?? "";
  const label = notOnScheduleText(state);
  return scheduleNote ? `${label}; ${scheduleNote}` : label;
}
