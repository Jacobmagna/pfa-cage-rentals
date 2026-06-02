// Pure over-cap red-flag logic for the admin Attendance-by-Program grid
// (FEAT-11, DEC-26 + DEC-03). No DB, no React, no I/O — consumes the
// FEAT-10 grid shape (athletes / sessions / present) plus the selected
// program's cap + capPeriod and returns which present cells are OVER the
// cap. The page builds the grid (buildAttendanceGrid) and reads the
// program row; this layers the flags on top. Mirrors the pure-transform
// + unit-test pattern of src/lib/reports/aggregate.ts.
//
// Settled decisions implemented exactly:
//  - DEC-26 present-only: only sessions where present === true count
//    toward the cap. Absent (A) and blank cells are never flagged.
//  - DEC-03 period: capPeriod "month" → calendar month; "week" →
//    Sunday–Saturday week.
//  - Period key = pure calendar arithmetic on the "YYYY-MM-DD"
//    sessionDate (no Intl/instant math — a calendar day's weekday is
//    timezone-independent, so this is DST-irrelevant and unit-testable).
//  - Within each (athlete, period bucket), order the athlete's PRESENT
//    sessions ascending by sessionDate; positions 1..cap are within
//    limit, positions cap+1 and beyond are OVER → flagged.
//  - Only when cap != null && capPeriod != null. Uncapped → no flags.

import {
  formatGridDate,
  type GridAthlete,
  type GridSession,
} from "@/lib/server/attendance-grid";

export type OverCapInfo = {
  periodLabel: string;
  indexInPeriod: number; // 1-based position within the period (> cap)
  periodPresentCount: number; // total present sessions in this period
  cap: number;
};

// athleteId → sessionId → info. Present only for flagged (over) cells.
export type OverCapFlags = Record<string, Record<string, OverCapInfo>>;

const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * Month bucket key for a "YYYY-MM-DD" calendar string → "YYYY-MM".
 */
export function monthKey(dateStr: string): string {
  return dateStr.slice(0, 7);
}

/**
 * Week bucket key for a "YYYY-MM-DD" calendar string → the Sunday-of-week
 * date as "YYYY-MM-DD" (Sunday–Saturday weeks, DEC-03). Pure calendar
 * arithmetic: a calendar date's weekday is timezone-independent, so we
 * use Date.UTC(...) purely as a calendar (never as an instant) to get the
 * weekday and to roll back to the Sunday — month/year rollover handled by
 * the UTC date math.
 */
export function weekKey(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const base = Date.UTC(y, m - 1, d);
  const dow = new Date(base).getUTCDay(); // 0 = Sunday
  const sunday = new Date(base - dow * 86_400_000);
  const yy = sunday.getUTCFullYear();
  const mm = String(sunday.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(sunday.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/**
 * Human label for a period bucket. month → "June 2026"; week →
 * "Week of Jun 1" (reuses formatGridDate for the Sunday). Pure — no TZ.
 */
function periodLabel(
  capPeriod: "week" | "month",
  key: string,
  sundayDateStr: string,
): string {
  if (capPeriod === "month") {
    const [y, m] = key.split("-").map(Number);
    return `${MONTHS_LONG[m - 1]} ${y}`;
  }
  return `Week of ${formatGridDate(sundayDateStr)}`;
}

/**
 * Computes which present cells are OVER the program's cap. Returns {} when
 * uncapped. See module header for the settled decisions.
 */
export function computeOverCapFlags(input: {
  athletes: GridAthlete[];
  sessions: GridSession[];
  present: Record<string, Record<string, boolean>>;
  cap: number | null;
  capPeriod: "week" | "month" | null;
}): OverCapFlags {
  const { athletes, sessions, present, cap, capPeriod } = input;
  if (cap == null || capPeriod == null) return {};

  // sessionId → sessionDate lookup.
  const dateById = new Map<string, string>();
  for (const s of sessions) dateById.set(s.id, s.sessionDate);

  const flags: OverCapFlags = {};

  for (const a of athletes) {
    const marks = present[a.id];
    if (!marks) continue;

    // Present sessions for this athlete, resolved to { id, date }.
    const presentSessions: { id: string; date: string }[] = [];
    for (const [sessionId, isPresent] of Object.entries(marks)) {
      if (isPresent !== true) continue;
      const date = dateById.get(sessionId);
      if (date === undefined) continue;
      presentSessions.push({ id: sessionId, date });
    }
    if (presentSessions.length === 0) continue;

    // Group by period key.
    const groups = new Map<string, { id: string; date: string }[]>();
    for (const ps of presentSessions) {
      const key =
        capPeriod === "month" ? monthKey(ps.date) : weekKey(ps.date);
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(ps);
    }

    for (const [key, group] of groups) {
      // Sort ascending by sessionDate (string compare is correct for
      // "YYYY-MM-DD"); tie-break on session id for determinism.
      group.sort((x, y) => x.date.localeCompare(y.date) || x.id.localeCompare(y.id));
      const periodPresentCount = group.length;
      const label = periodLabel(capPeriod, key, key);
      for (let i = 0; i < group.length; i++) {
        const indexInPeriod = i + 1; // 1-based
        if (indexInPeriod <= cap) continue; // within limit
        (flags[a.id] ??= {})[group[i].id] = {
          periodLabel: label,
          indexInPeriod,
          periodPresentCount,
          cap,
        };
      }
    }
  }

  return flags;
}
