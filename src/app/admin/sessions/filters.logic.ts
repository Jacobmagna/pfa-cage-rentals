import { pfaParts } from "@/lib/timezone";

// Pure date math for the Sessions tab default From/To range.
//
// Extracted from the server component so it can be unit-tested without
// a DB. The Sessions tab is used to scan both recent-past and upcoming
// bookings, so the default window straddles "today" in the FACILITY
// timezone: From = today − 14 days, To = today + 14 days (both inclusive).
//
// "today" is derived via pfaParts so it reflects the PFA wall-clock day
// even when the server runs on UTC (Vercel). The detached Y-M-D numbers
// are fed into a plain JS Date purely as a calendar counter for the
// ±14-day add/subtract — that Date is never compared as an instant, so
// the runtime's local TZ is irrelevant. Output is "YYYY-MM-DD" strings
// matching the masked date inputs in the filter bar.

/** Default days before/after today for the inclusive From/To window. */
export const DEFAULT_RANGE_DAYS = 14;

export type DefaultSessionsRange = {
  /** today − DEFAULT_RANGE_DAYS, as "YYYY-MM-DD" in PFA TZ. */
  from: string;
  /** today + DEFAULT_RANGE_DAYS, as "YYYY-MM-DD" in PFA TZ. */
  to: string;
};

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

/**
 * The default Sessions filter range for a given instant `now`,
 * computed against the PFA-local calendar day of `now`:
 *   from = (PFA today) − DEFAULT_RANGE_DAYS days
 *   to   = (PFA today) + DEFAULT_RANGE_DAYS days
 * Both bounds are inclusive "YYYY-MM-DD" strings.
 */
export function defaultSessionsRange(now: Date): DefaultSessionsRange {
  const today = pfaParts(now);
  const shift = (days: number): string => {
    // Plain Date as a pure calendar counter (local TZ irrelevant — never
    // read back as an instant). setDate handles month/year rollover and
    // varying month lengths for us.
    const counter = new Date(today.year, today.month - 1, today.day);
    counter.setDate(counter.getDate() + days);
    return `${counter.getFullYear()}-${pad2(counter.getMonth() + 1)}-${pad2(counter.getDate())}`;
  };
  return {
    from: shift(-DEFAULT_RANGE_DAYS),
    to: shift(DEFAULT_RANGE_DAYS),
  };
}
