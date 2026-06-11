// Shared month-param parsing for the admin attendance grids (by-program,
// by-player) and the attendance Excel download route (QA2 #12/#13/#14).
//
// attendance_sessions.sessionDate is a `date` column read as a plain
// "YYYY-MM-DD" calendar string (no timezone). So month scoping is pure
// string math: the bounds are calendar-date strings the query compares
// directly against sessionDate (>= first-of-month AND < first-of-next-
// month), and the displayed/default "current month" is resolved in PFA
// TZ so it matches what the admin's clock says regardless of server TZ.
//
// One module so the two pages and the download route agree on the
// contract — rename or re-default once, all three update.

import { formatPfaMonthYear, pfaParts } from "@/lib/timezone";

export type AttendanceMonth = {
  /** Selected month as "YYYY-MM". */
  month: string;
  /** Inclusive lower bound — "YYYY-MM-01" of the selected month. */
  firstDay: string;
  /** Exclusive upper bound — "YYYY-MM-01" of the FOLLOWING month. */
  nextMonthFirstDay: string;
  /** Previous month as "YYYY-MM" (for ‹ prev nav). */
  prevMonth: string;
  /** Next month as "YYYY-MM" (for next › nav). */
  nextMonth: string;
  /** "June 2026" — human label for the month header. */
  label: string;
};

const MONTH_RE = /^(\d{4})-(\d{2})$/;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** The current PFA-calendar month as "YYYY-MM". */
export function currentPfaMonth(now: Date = new Date()): string {
  const p = pfaParts(now);
  return `${p.year}-${pad2(p.month)}`;
}

/**
 * Resolves a raw `?month=` param into the canonical AttendanceMonth.
 * Falls back to the current PFA month when the param is missing or not a
 * valid "YYYY-MM" (month 01-12).
 */
export function resolveAttendanceMonth(
  raw: string | undefined,
  now: Date = new Date(),
): AttendanceMonth {
  const month = isValidMonth(raw) ? raw : currentPfaMonth(now);
  const [yearStr, monthStr] = month.split("-");
  const year = Number(yearStr);
  const mon = Number(monthStr); // 1-12

  const firstDay = `${month}-01`;

  const nextMon = mon === 12 ? 1 : mon + 1;
  const nextYear = mon === 12 ? year + 1 : year;
  const nextMonth = `${nextYear}-${pad2(nextMon)}`;
  const nextMonthFirstDay = `${nextMonth}-01`;

  const prevMon = mon === 1 ? 12 : mon - 1;
  const prevYear = mon === 1 ? year - 1 : year;
  const prevMonth = `${prevYear}-${pad2(prevMon)}`;

  // Build the label from a noon-on-the-first Date in a TZ-agnostic way:
  // formatPfaMonthYear formats in PFA TZ, and the 1st-at-noon UTC anchor
  // is the 1st in PFA TZ too (PFA is UTC-7/8), so the month never slips.
  const labelAnchor = new Date(Date.UTC(year, mon - 1, 1, 12, 0, 0));
  const label = formatPfaMonthYear(labelAnchor);

  return {
    month,
    firstDay,
    nextMonthFirstDay,
    prevMonth,
    nextMonth,
    label,
  };
}

function isValidMonth(v: string | undefined): v is string {
  if (typeof v !== "string") return false;
  const m = MONTH_RE.exec(v);
  if (!m) return false;
  const mon = Number(m[2]);
  return mon >= 1 && mon <= 12;
}
