// Single source of truth for the timezone PFA operates in.
//
// PFA Baseball's cages are physical and located in Princeton, NJ
// (US Eastern). Every user-facing date/time display must format in
// this timezone so what the admin types ("9 AM") matches what every
// viewer sees, regardless of where the server runs (Vercel UTC) or
// where any individual user's browser is.
//
// The DB stores UTC instants for sessions / blocks / audit; this
// module is the conversion layer on the read path.
//
// Hardcoded rather than env-driven because (a) one customer, one TZ,
// (b) an accidentally-unset env var on Vercel would silently regress
// to UTC display. If PFA ever opens a second location with its own
// hours, promote to env-driven config and pick at request time.

export const PFA_TIMEZONE = "America/New_York";

/**
 * "2026-05-24" — ISO date string in PFA TZ. Stable across server +
 * client. Used by report rows + anywhere we need a date as a string.
 */
export function formatPfaDate(d: Date): string {
  // en-CA's short date format is YYYY-MM-DD — gives us the ISO shape
  // for free without manual padding logic.
  return d.toLocaleDateString("en-CA", { timeZone: PFA_TIMEZONE });
}

/**
 * "09:00" — 24-hour HH:MM in PFA TZ.
 */
export function formatPfaTime(d: Date): string {
  return d.toLocaleTimeString("en-GB", {
    timeZone: PFA_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * "Mon" — three-letter weekday in PFA TZ.
 */
export function formatPfaWeekday(d: Date): string {
  return d.toLocaleDateString("en-US", {
    timeZone: PFA_TIMEZONE,
    weekday: "short",
  });
}

/**
 * "Sunday, May 24, 2026" — long-form date for page headers.
 */
export function formatPfaDateLong(d: Date): string {
  return d.toLocaleDateString("en-US", {
    timeZone: PFA_TIMEZONE,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * "May 24, 2026" — medium-form date used in lists (joined, etc).
 */
export function formatPfaDateMedium(d: Date): string {
  return d.toLocaleDateString("en-US", {
    timeZone: PFA_TIMEZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * "May 2026" — month + year for monthly reports / period labels.
 */
export function formatPfaMonthYear(d: Date): string {
  return d.toLocaleDateString("en-US", {
    timeZone: PFA_TIMEZONE,
    month: "long",
    year: "numeric",
  });
}

/**
 * Converts a PFA wall-clock date+time to its UTC instant. Inverse of
 * formatPfaDate + formatPfaTime: format(pfaWallClockToUtc(d, t))
 * round-trips.
 *
 * Used by the historical Excel import (I3): the parser emits
 * "YYYY-MM-DD" + "HH:mm" in PFA local; the sessions table stores
 * UTC Date instants. Wall-clock 14:30 on 2026-05-01 (EDT, UTC-4)
 * becomes 18:30 UTC.
 *
 * Strategy: build the wall-clock-as-if-UTC instant, ask Intl for
 * the PFA offset at that moment, subtract it back. Survives DST
 * for any wall-time in the operating window (8:00–22:00); the
 * unrepresentable 02:00–03:00 spring-forward gap can't appear in
 * imported data.
 */
export function pfaWallClockToUtc(date: string, time: string): Date {
  const naive = new Date(`${date}T${time}:00Z`);
  if (Number.isNaN(naive.getTime())) {
    throw new Error(`pfaWallClockToUtc: invalid date/time "${date}T${time}"`);
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: PFA_TIMEZONE,
    timeZoneName: "shortOffset",
  }).formatToParts(naive);
  const offsetPart = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+0";
  const match = offsetPart.match(/GMT([+-])(\d+)(?::(\d+))?/);
  if (!match) throw new Error(`pfaWallClockToUtc: could not parse offset "${offsetPart}"`);
  const sign = match[1] === "+" ? 1 : -1;
  const offsetMin = sign * (Number(match[2]) * 60 + Number(match[3] ?? 0));
  return new Date(naive.getTime() - offsetMin * 60_000);
}

/**
 * Form-action alias for pfaWallClockToUtc. Semantically clearer
 * at call sites that translate a `<input type="date">` + `<input type="time">`
 * pair into a UTC instant for DB insert.
 */
export const parsePfaInput = pfaWallClockToUtc;

/**
 * PFA wall-clock hour at instant `d` (0-23). For schedule-grid math
 * that places a session in a column based on its hour.
 */
export function pfaHour(d: Date): number {
  return pfaParts(d).hour;
}

/**
 * PFA wall-clock minute at instant `d` (0-59).
 */
export function pfaMinute(d: Date): number {
  return pfaParts(d).minute;
}

/**
 * Returns the UTC instant whose PFA wall-clock is `(hour, minute)` on the
 * same PFA calendar day as `d`. Used by the schedule grid for click-to-create
 * and drag-to-move: "the slot at 9:00 AM on the day currently shown."
 */
export function pfaWallClockAt(d: Date, hour: number, minute: number): Date {
  const p = pfaParts(d);
  return pfaWallClockToUtc(
    `${p.year}-${pad2(p.month)}-${pad2(p.day)}`,
    `${pad2(hour)}:${pad2(minute)}`,
  );
}

/**
 * First UTC instant of the PFA calendar day containing `d`. Used for
 * server-side bucketing — e.g. "today's sessions" / "May reports". Safe
 * on Vercel UTC: a 11:30 PM ET session on May 31 lands in the May bucket
 * even though its UTC time is in June.
 */
export function pfaDayStart(d: Date): Date {
  return pfaWallClockAt(d, 0, 0);
}

/**
 * First UTC instant of the PFA calendar day AFTER `d`. DST-safe: walks
 * forward by 25h then snaps to PFA midnight, so spring-forward (23h
 * day) and fall-back (25h day) both land on the right boundary.
 */
export function pfaDayEnd(d: Date): Date {
  const tomorrow = new Date(d.getTime() + 25 * 60 * 60 * 1000);
  return pfaDayStart(tomorrow);
}

/**
 * First UTC instant of the PFA calendar month containing `d`.
 */
export function pfaMonthStart(d: Date): Date {
  const p = pfaParts(d);
  return pfaWallClockToUtc(`${p.year}-${pad2(p.month)}-01`, "00:00");
}

/**
 * First UTC instant of the PFA calendar month AFTER `d`. Used as the
 * exclusive upper bound when querying "all sessions in month X".
 */
export function pfaMonthEnd(d: Date): Date {
  const p = pfaParts(d);
  const nextMonth = p.month === 12 ? 1 : p.month + 1;
  const nextYear = p.month === 12 ? p.year + 1 : p.year;
  return pfaWallClockToUtc(`${nextYear}-${pad2(nextMonth)}-01`, "00:00");
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * UTC instant range [startUtc, endUtc) for the Sunday→Saturday PFA-local
 * week containing the calendar date `dateStr` ("YYYY-MM-DD").
 *
 * The week starts at PFA-local midnight on the Sunday at or before
 * `dateStr` and ends at PFA-local midnight on the following Sunday. The
 * range is half-open: startUtc inclusive, endUtc exclusive — matching
 * pfaMonthStart/End so callers can use the same `>= start AND < end`
 * query shape.
 *
 * DST-safe: we anchor on noon (never inside the 02:00–03:00 spring-
 * forward gap) and snap each boundary to PFA midnight via
 * pfaWallClockToUtc, so the spring-forward (23h) and fall-back (25h)
 * weeks both land on the correct calendar Sundays.
 */
export function pfaWeekRange(dateStr: string): {
  startUtc: Date;
  endUtc: Date;
} {
  // PFA-local weekday (0=Sun..6=Sat) of the noon anchor on `dateStr`,
  // derived from the long name so it's unambiguous across locales.
  const noon = pfaWallClockToUtc(dateStr, "12:00");
  const longName = new Intl.DateTimeFormat("en-US", {
    timeZone: PFA_TIMEZONE,
    weekday: "long",
  }).format(noon);
  const WEEKDAYS = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
  const dow = WEEKDAYS.indexOf(longName);

  // Walk the noon anchor back to this week's Sunday and forward to the
  // next Sunday, then read off the PFA calendar dates and snap to PFA
  // midnight. ±25h-per-day stepping keeps us off DST boundaries.
  const sundayNoon = new Date(noon.getTime() - dow * 24 * 60 * 60 * 1000);
  const nextSundayNoon = new Date(
    noon.getTime() + (7 - dow) * 24 * 60 * 60 * 1000,
  );
  const sP = pfaParts(sundayNoon);
  const nP = pfaParts(nextSundayNoon);
  const startUtc = pfaWallClockToUtc(
    `${sP.year}-${pad2(sP.month)}-${pad2(sP.day)}`,
    "00:00",
  );
  const endUtc = pfaWallClockToUtc(
    `${nP.year}-${pad2(nP.month)}-${pad2(nP.day)}`,
    "00:00",
  );
  return { startUtc, endUtc };
}

/**
 * UTC instant range [startUtc, endUtc) for the PFA-local calendar month
 * containing the calendar date `dateStr` ("YYYY-MM-DD"). Half-open:
 * startUtc inclusive (1st at PFA midnight), endUtc exclusive (1st of the
 * next month at PFA midnight). Thin wrapper over pfaMonthStart /
 * pfaMonthEnd that accepts a date string instead of a Date.
 */
export function pfaMonthRange(dateStr: string): {
  startUtc: Date;
  endUtc: Date;
} {
  const anchor = pfaWallClockToUtc(dateStr, "12:00");
  return { startUtc: pfaMonthStart(anchor), endUtc: pfaMonthEnd(anchor) };
}

/**
 * Returns the wall-clock parts (year, month, day, hour, minute) at
 * `d` in PFA TZ. Useful for "what is the current PFA day" without
 * relying on the runtime's local TZ.
 *
 * Month is 1-indexed (matches Date.UTC's convention NOT Date()'s).
 */
export function pfaParts(d: Date): {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
} {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: PFA_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(d)) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Intl can return "24" for midnight in some locales — normalize.
    hour: Number(parts.hour) === 24 ? 0 : Number(parts.hour),
    minute: Number(parts.minute),
  };
}
