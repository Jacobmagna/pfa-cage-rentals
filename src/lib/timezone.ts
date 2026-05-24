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
