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

/**
 * Expand a weekly recurrence definition into concrete occurrences.
 *
 * Iterates every calendar date from `startsOn` to `endsOn` inclusive,
 * computing each date's weekday with pure UTC calendar math
 * (`new Date(Date.UTC(y, m-1, d)).getUTCDay()`, 0=Sun..6=Sat). A date is
 * included iff its weekday is in `daysOfWeek` and it is not in
 * `skipDates`. For each included date the wall-clock `startTime`/`endTime`
 * are resolved to UTC instants via `pfaWallClockToUtc` (DST-correct).
 *
 * Throws on invalid input (empty/out-of-range weekdays, malformed
 * times/dates, start>=end time, startsOn>endsOn) and when the result
 * would exceed MAX_OCCURRENCES.
 */
export function generateOccurrences(
  input: GenerateOccurrencesInput,
): Occurrence[] {
  const { daysOfWeek, startTime, endTime, startsOn, endsOn } = input;
  const skipDates = input.skipDates ?? [];

  if (!Array.isArray(daysOfWeek) || daysOfWeek.length === 0) {
    throw new Error("daysOfWeek must be a non-empty array");
  }
  for (const dow of daysOfWeek) {
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) {
      throw new Error(`daysOfWeek values must be integers 0–6, got ${dow}`);
    }
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

  const wanted = new Set(daysOfWeek);
  const skip = new Set(skipDates);
  const occurrences: Occurrence[] = [];

  // Walk day-by-day in UTC. One UTC calendar day is exactly 24h, so
  // stepping the underlying instant by 86_400_000 ms advances the date
  // without any TZ ambiguity. We re-derive the YYYY-MM-DD string from the
  // UTC parts each step.
  for (let ms = startMs; ms <= endMs; ms += 86_400_000) {
    const cur = new Date(ms);
    const dow = cur.getUTCDay();
    if (!wanted.has(dow)) continue;

    const date = `${cur.getUTCFullYear()}-${pad2(cur.getUTCMonth() + 1)}-${pad2(
      cur.getUTCDate(),
    )}`;
    if (skip.has(date)) continue;

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

  return occurrences;
}
