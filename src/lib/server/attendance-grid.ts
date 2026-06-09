// Pure assembly for the admin Attendance-by-Program grid (FEAT-10).
// No DB, no React, no I/O — the page does the set-based reads
// (mirroring src/lib/reports/fetch.ts) and hands the raw rows here.
// Mirrors the pure-transform + unit-test pattern of
// src/lib/reports/aggregate.ts.
//
// Rows = the union of (current program roster) and (any athlete with a
// record in this program's sessions), deduped by id. A de-rostered
// athlete with past records still appears; a current-roster athlete
// with no records appears as an all-blank row. Cols = the program's
// attendance sessions, ascending by sessionDate. Cells = present
// (true) / absent (false) / blank (no record).
//
// Read-only: this never decides "over cap" or red-flags — a later
// feature layers that on top of this shape, so the lookup is kept as a
// simple nested map keyed by athleteId → sessionId.

export type GridAthlete = {
  id: string;
  firstName: string;
  lastName: string;
};

export type GridSession = {
  id: string;
  sessionDate: string; // "YYYY-MM-DD"
};

export type GridRecordInput = {
  sessionId: string;
  athleteId: string;
  present: boolean;
};

export type AttendanceGrid = {
  athletes: GridAthlete[];
  sessions: GridSession[];
  // outer key = athleteId, inner key = sessionId. An absent inner key
  // is a blank cell (no record taken for that athlete that session).
  present: Record<string, Record<string, boolean>>;
};

/**
 * Builds the canonical grid shape from raw athlete / session / record
 * rows. Pure — no side effects, no DB.
 *
 * - Dedups athletes by id (caller concatenates roster + record-athletes).
 * - Sorts athletes by lastName then firstName (locale compare, matching
 *   the existing roster sort).
 * - Sorts sessions ascending by sessionDate (string compare is correct
 *   for "YYYY-MM-DD").
 * - Builds present[athleteId][sessionId] = record.present.
 */
export function buildAttendanceGrid(input: {
  athletes: GridAthlete[];
  sessions: GridSession[];
  records: GridRecordInput[];
}): AttendanceGrid {
  const byId = new Map<string, GridAthlete>();
  for (const a of input.athletes) {
    if (!byId.has(a.id)) byId.set(a.id, a);
  }
  const athletes = Array.from(byId.values()).sort(
    (a, b) =>
      a.lastName.localeCompare(b.lastName) ||
      a.firstName.localeCompare(b.firstName),
  );

  const sessions = [...input.sessions].sort((a, b) =>
    a.sessionDate.localeCompare(b.sessionDate),
  );

  const present: Record<string, Record<string, boolean>> = {};
  for (const r of input.records) {
    (present[r.athleteId] ??= {})[r.sessionId] = r.present;
  }

  return { athletes, sessions, present };
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * "Jun 3" from a "YYYY-MM-DD" calendar string. Session dates are
 * pure calendar days (no timezone), so we format the month/day parts
 * directly — no Date/timezone conversion that could shift the displayed
 * day. Mirrors the roster's formatBirthday approach.
 *
 * Used both for per-day grid columns AND for the weekday-less "Week of
 * {date}" period labels in attendance-flags.ts — so this stays without a
 * weekday. For the per-day display sites that want the weekday prefix,
 * use formatGridDateWithWeekday.
 */
export function formatGridDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d || m < 1 || m > 12) return iso;
  return `${MONTHS[m - 1]} ${d}`;
}

/**
 * "Wed, Jun 3" from a "YYYY-MM-DD" calendar string — the weekday-prefixed
 * form for per-day display sites (attendance grid columns / by-player date
 * cells). The weekday is derived from a UTC-anchored Date (read via
 * getUTCDay) so it stays on the same calendar day regardless of the
 * runtime's local timezone. Falls back to the raw string when it doesn't
 * parse, matching formatGridDate.
 */
export function formatGridDateWithWeekday(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d || m < 1 || m > 12) return iso;
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${weekday}, ${MONTHS[m - 1]} ${d}`;
}
