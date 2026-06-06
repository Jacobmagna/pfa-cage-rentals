// Pure, DB-free occurrence generator for recurring program-schedule
// series (RECUR-a). Given a weekly recurrence definition (weekdays + a
// wall-clock window + a season start/end), it expands every matching
// calendar date into a concrete UTC instant pair the materialized
// program_schedule_blocks rows store.
//
// PURITY: no DB, no `new Date()` for "now", no viewer-timezone Date
// parsing. Weekdays come from UTC calendar math (Date.UTC(...).getUTCDay)
// so they never drift with the runtime TZ; the wall-clock → UTC
// conversion is delegated to pfaWallClockToUtc so DST is handled exactly
// the way the rest of the app handles it. This keeps the function fully
// unit-testable and deterministic.

import { pfaWallClockToUtc } from "@/lib/timezone";

// Hard cap on generated occurrences. A weekly recurrence on all 7 days
// for a full year is 366 (leap year); anything larger means the input
// range is unreasonable and we refuse rather than materialize a runaway
// number of blocks.
export const MAX_OCCURRENCES = 366;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface GenerateOccurrencesInput {
  daysOfWeek: number[];
  startTime: string;
  endTime: string;
  startsOn: string;
  endsOn: string;
  skipDates?: string[];
  // RECUR-a: recurrence frequency + interval. Both optional and default
  // to weekly/1 so omitting them reproduces the original weekly behavior
  // exactly (back-compat for existing series rows + callers).
  //  - "weekly" + interval N: a weekday matches only when the index of
  //    the week it falls in (relative to startsOn's Sunday week) is a
  //    multiple of N. N=1 ⇒ every week; 2 ⇒ every other week; etc.
  //  - "monthly" + interval N: the weekday + its ordinal-within-month
  //    (1st..5th) are derived from startsOn; we emit that ordinal weekday
  //    in every Nth month, skipping any month that lacks the ordinal
  //    (e.g. no 5th Tuesday). daysOfWeek is not expanded for monthly.
  frequency?: "weekly" | "monthly";
  interval?: number;
}

export interface Occurrence {
  date: string;
  startAt: Date;
  endAt: Date;
}

// Parses a "YYYY-MM-DD" string into its numeric parts. Throws on a
// malformed string or an impossible calendar date (e.g. 2026-02-30).
function parseDateParts(s: string): { y: number; m: number; d: number } {
  if (!DATE_RE.test(s)) {
    throw new Error(`Invalid date "${s}" — expected YYYY-MM-DD`);
  }
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  // Reject impossible dates by round-tripping through Date.UTC.
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== m - 1 ||
    probe.getUTCDate() !== d
  ) {
    throw new Error(`Invalid calendar date "${s}"`);
  }
  return { y, m, d };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

const DAY_MS = 86_400_000;

// Format the UTC date represented by `ms` (a midnight-UTC instant) as
// "YYYY-MM-DD" using its UTC calendar parts.
function utcDateString(ms: number): string {
  const cur = new Date(ms);
  return `${cur.getUTCFullYear()}-${pad2(cur.getUTCMonth() + 1)}-${pad2(
    cur.getUTCDate(),
  )}`;
}

// Build an Occurrence for a "YYYY-MM-DD" date, resolving the wall-clock
// start/end to UTC instants. Enforces the MAX_OCCURRENCES cap against the
// running list. Shared by both the weekly and monthly expanders so the
// DST math + cap behavior are identical.
function pushOccurrence(
  occurrences: Occurrence[],
  date: string,
  startTime: string,
  endTime: string,
): void {
  if (occurrences.length >= MAX_OCCURRENCES) {
    throw new Error(
      `Recurrence generates more than ${MAX_OCCURRENCES} occurrences — narrow the date range or weekdays`,
    );
  }
  occurrences.push({
    date,
    startAt: pfaWallClockToUtc(date, startTime),
    endAt: pfaWallClockToUtc(date, endTime),
  });
}

/**
 * Expand a recurrence definition into concrete occurrences.
 *
 * Two frequencies (default `"weekly"` for back-compat):
 *
 * weekly (interval N): iterate every calendar date from `startsOn` to
 * `endsOn` inclusive (pure UTC calendar math, 0=Sun..6=Sat). A date is
 * included iff its weekday ∈ `daysOfWeek`, the index of its week is a
 * multiple of N, and it is not in `skipDates`. The week index is relative
 * to the Sunday-based week containing `startsOn`:
 * `weekStart = startsOn − getUTCDay(startsOn) days`,
 * `weekIndex = floor((dateMs − weekStartMs) / 7 days)`. N=1 ⇒ every week
 * (original behavior); 2 ⇒ every other week; N ⇒ every N weeks.
 *
 * monthly (interval N): derive the target weekday + its ordinal within
 * the month (1st..5th occurrence of that weekday) from `startsOn`. For
 * each month starting at `startsOn`'s month, stepping by N months, emit
 * the ordinal-th occurrence of that weekday — skipping any month that has
 * no such ordinal (e.g. no 5th Tuesday). Only dates in `[startsOn,
 * endsOn]` and not in `skipDates` are kept. `daysOfWeek` is not expanded
 * for monthly (the weekday comes from `startsOn`).
 *
 * For each included date the wall-clock `startTime`/`endTime` are resolved
 * to UTC instants via `pfaWallClockToUtc` (DST-correct).
 *
 * Throws on invalid input (empty/out-of-range weekdays, malformed
 * times/dates, start>=end time, startsOn>endsOn, bad frequency, interval
 * not an integer ≥ 1) and when the result would exceed MAX_OCCURRENCES.
 */
export function generateOccurrences(
  input: GenerateOccurrencesInput,
): Occurrence[] {
  const { daysOfWeek, startTime, endTime, startsOn, endsOn } = input;
  const skipDates = input.skipDates ?? [];
  const frequency = input.frequency ?? "weekly";
  const interval = input.interval ?? 1;

  if (!Array.isArray(daysOfWeek) || daysOfWeek.length === 0) {
    throw new Error("daysOfWeek must be a non-empty array");
  }
  for (const dow of daysOfWeek) {
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) {
      throw new Error(`daysOfWeek values must be integers 0–6, got ${dow}`);
    }
  }
  if (frequency !== "weekly" && frequency !== "monthly") {
    throw new Error(`frequency must be "weekly" or "monthly", got ${frequency}`);
  }
  if (!Number.isInteger(interval) || interval < 1) {
    throw new Error(`interval must be an integer ≥ 1, got ${interval}`);
  }
  if (!TIME_RE.test(startTime)) {
    throw new Error(`Invalid startTime "${startTime}" — expected HH:MM`);
  }
  if (!TIME_RE.test(endTime)) {
    throw new Error(`Invalid endTime "${endTime}" — expected HH:MM`);
  }
  if (startTime >= endTime) {
    // Lexicographic compare is correct for zero-padded 24h HH:MM.
    throw new Error("startTime must be before endTime");
  }

  const start = parseDateParts(startsOn);
  const end = parseDateParts(endsOn);
  // Compare via UTC instants to validate ordering.
  const startMs = Date.UTC(start.y, start.m - 1, start.d);
  const endMs = Date.UTC(end.y, end.m - 1, end.d);
  if (startMs > endMs) {
    throw new Error("startsOn must be on or before endsOn");
  }

  const skip = new Set(skipDates);
  const occurrences: Occurrence[] = [];

  if (frequency === "monthly") {
    // The target weekday + its ordinal-within-month both come from
    // startsOn. ordinal = ceil(dayOfMonth / 7), i.e. the 1st..5th
    // occurrence of that weekday in startsOn's month.
    const targetWeekday = new Date(startMs).getUTCDay();
    const ordinal = Math.ceil(start.d / 7);

    // Walk months from startsOn's month, stepping by `interval`. We bound
    // the loop by endsOn (plus a generous slack) so it always terminates.
    let y = start.y;
    let m = start.m; // 1-based month
    while (true) {
      // First day of this month (UTC) and its weekday.
      const firstMs = Date.UTC(y, m - 1, 1);
      if (firstMs > endMs) break;

      const firstWeekday = new Date(firstMs).getUTCDay();
      // Day-of-month of the 1st occurrence of targetWeekday this month.
      const firstOffset = (targetWeekday - firstWeekday + 7) % 7;
      const day = 1 + firstOffset + (ordinal - 1) * 7;

      // Does this month actually contain that ordinal weekday? Reject by
      // round-tripping through Date.UTC (overflow into next month means
      // the ordinal doesn't exist this month — e.g. no 5th Tuesday).
      const candidateMs = Date.UTC(y, m - 1, day);
      const probe = new Date(candidateMs);
      const inThisMonth = probe.getUTCMonth() === m - 1;

      if (inThisMonth && candidateMs >= startMs && candidateMs <= endMs) {
        const date = utcDateString(candidateMs);
        if (!skip.has(date)) {
          pushOccurrence(occurrences, date, startTime, endTime);
        }
      }

      // Advance by `interval` months.
      m += interval;
      while (m > 12) {
        m -= 12;
        y += 1;
      }
    }

    return occurrences;
  }

  // weekly (every N weeks). The week index is relative to the Sunday week
  // containing startsOn, so week 0 is always the start week.
  const wanted = new Set(daysOfWeek);
  const startWeekday = new Date(startMs).getUTCDay();
  const weekStartMs = startMs - startWeekday * DAY_MS;

  // Walk day-by-day in UTC. One UTC calendar day is exactly 24h, so
  // stepping the underlying instant by DAY_MS advances the date without
  // any TZ ambiguity. We re-derive the YYYY-MM-DD string from the UTC
  // parts each step.
  for (let ms = startMs; ms <= endMs; ms += DAY_MS) {
    const cur = new Date(ms);
    const dow = cur.getUTCDay();
    if (!wanted.has(dow)) continue;

    const weekIndex = Math.floor((ms - weekStartMs) / (7 * DAY_MS));
    if (weekIndex % interval !== 0) continue;

    const date = utcDateString(ms);
    if (skip.has(date)) continue;

    pushOccurrence(occurrences, date, startTime, endTime);
  }

  return occurrences;
}
