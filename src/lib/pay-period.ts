// stipend SPEC §5 — THE PAY PERIOD: a half-month, in PFA local time.
//
// Mark runs payroll twice a month: the 1st through the 15th, and the 16th
// through the end of the month. He was explicit that this is NOT "every 15
// days" — the second half is 16 days in a 31-day month, 15 in a 30-day month,
// and 13 or 14 in February. Any model built on a fixed interval drifts off his
// actual calendar within one month.
//
// ── Why this is its own module ───────────────────────────────────────────────
// Every existing money surface ranges by an arbitrary from/to, and every period
// PRESET in the app is a calendar month (`src/lib/statement/period.ts`). The
// half-month is a genuinely new time grammar, so it gets one home rather than
// being open-coded at each call site. The stipend is its first consumer; the
// private-lesson feature's pay timing is expected to be its second.
//
// ── Pure, and clock-injected ────────────────────────────────────────────────
// No DB, no React, no I/O, and NO `Date.now()` / argless `new Date()`. `now`
// arrives as a parameter, exactly as `statementPeriodPresets` and
// `reconciliation.ts` already do, so the year-wrap and DST cases are testable
// with literals instead of a mock.
//
// 🔴 EVERY BOUNDARY IS PFA-PINNED, NEVER SERVER-UTC. Boundaries are resolved
// through `pfaWallClockToUtc` / `pfaParts`, which read named Intl parts and are
// locale- and runtime-TZ-independent. Deriving a boundary from the server clock
// would misbucket every instant between PFA midnight and UTC midnight — a
// seven-to-eight hour window, every single day, on the exact edge the whole
// feature turns on. This class of bug has bitten this repo TWICE (the naive
// `audit_log` timestamp, and Sentry PFAENGINE-2's locale-dependent date), which
// is why `pay-period.test.ts` runs under four timezones.
//
// ── Half-open, like everything else here ────────────────────────────────────
// `[fromDate, toDateExclusive)`. PFA-midnight on the first day, up to but NOT
// including PFA-midnight on the day after the last day. This matches
// `NormalizedFilters`, `pfaMonthRange`, and the statement engine's charge
// predicate, so a pay period can be handed to an existing query shape
// unchanged. An instant at exactly PFA-midnight on the 16th is in P2, never P1.

import { PFA_TIMEZONE, pfaParts, pfaWallClockToUtc } from "@/lib/timezone";

/** 1 = the 1st–15th. 2 = the 16th–end of month. */
export type PayPeriodHalf = 1 | 2;

export type PayPeriod = {
  /**
   * "2026-08-P1" — stable, sortable, and unique per (coach-independent)
   * period. This is the value `coach_stipend_earnings.period_key` stores and
   * the one its UNIQUE(coach_id, period_key) constraint dedupes on, so it must
   * never change format for an already-earned period.
   */
  key: string;
  year: number;
  /** 1-12, matching `pfaParts` (NOT the 0-indexed `Date` convention). */
  month: number;
  half: PayPeriodHalf;
  /** UTC instant at PFA-midnight on the period's first day. Inclusive. */
  fromDate: Date;
  /** UTC instant at PFA-midnight on the day AFTER the period's last day. Exclusive. */
  toDateExclusive: Date;
};

/**
 * A runaway guard on `payPeriodsBetween`, not a real limit: 100 years of
 * periods. A range wide enough to exceed this is a bug in the caller (an
 * uninitialized date, a swapped epoch), and failing loudly with the range in
 * the message beats allocating until the process dies.
 */
const MAX_PERIODS = 2400;

/**
 * The pay period containing `d`.
 *
 * The 15th/16th split is read from the PFA calendar day, so an instant late on
 * the 15th Pacific stays in P1 even though it is already the 16th in UTC.
 */
export function payPeriodFor(d: Date): PayPeriod {
  assertValidDate(d, "payPeriodFor");
  const parts = pfaParts(d);
  return buildPayPeriod(parts.year, parts.month, parts.day <= 15 ? 1 : 2);
}

/**
 * The period immediately after `p`. P1 → P2 of the same month; P2 → P1 of the
 * next month, wrapping the year in December.
 */
export function nextPayPeriod(p: PayPeriod): PayPeriod {
  if (p.half === 1) return buildPayPeriod(p.year, p.month, 2);
  const wrapped = p.month === 12;
  return buildPayPeriod(wrapped ? p.year + 1 : p.year, wrapped ? 1 : p.month + 1, 1);
}

/**
 * Every pay period OVERLAPPING the half-open range `[fromDate, toDateExclusive)`,
 * oldest first.
 *
 * ⚠️ OVERLAPPING, not "contained in" — and that is the behaviour callers must
 * understand rather than the one they might assume. A report filtered
 * Aug 10 → Aug 20 overlaps BOTH Aug 1–15 and Aug 16–31, so a coach on a stipend
 * shows TWO full stipends inside a ten-day window. That is arithmetically right
 * (a stipend is not pro-ratable — Mark rejected pro-rating explicitly) and it
 * WILL look wrong to a reader, which is why SPEC §10.4 requires every stipend
 * line to print its own period label.
 *
 * Returns `[]` for an empty or inverted range rather than throwing: an inverted
 * from/to is already reachable through the existing filter bar (SPEC open item
 * 5h) and every other surface renders it as "nothing here" instead of an error.
 */
export function payPeriodsBetween(
  fromDate: Date,
  toDateExclusive: Date,
): PayPeriod[] {
  assertValidDate(fromDate, "payPeriodsBetween");
  assertValidDate(toDateExclusive, "payPeriodsBetween");
  if (toDateExclusive.getTime() <= fromDate.getTime()) return [];

  const periods: PayPeriod[] = [];
  let current = payPeriodFor(fromDate);
  while (current.fromDate.getTime() < toDateExclusive.getTime()) {
    periods.push(current);
    if (periods.length > MAX_PERIODS) {
      throw new Error(
        `payPeriodsBetween: range exceeds ${MAX_PERIODS} periods ` +
          `(${fromDate.toISOString()} → ${toDateExclusive.toISOString()})`,
      );
    }
    current = nextPayPeriod(current);
  }
  return periods;
}

/** "Aug 1–15, 2026" · "Aug 16–31, 2026" · "Feb 16–28, 2026". */
export function payPeriodLabel(p: PayPeriod): string {
  const month = p.fromDate.toLocaleDateString("en-US", {
    timeZone: PFA_TIMEZONE,
    month: "short",
  });
  return `${month} ${p.half === 1 ? 1 : 16}–${lastDayOf(p)}, ${p.year}`;
}

/**
 * Whole days in `p` — 13, 14, 15 or 16. Mark's own reason the model cannot be
 * "every 15 days".
 *
 * ⚠️ `Math.round`, not a floor or an exact division: a period containing a DST
 * transition is 15 days MINUS an hour (spring forward) or PLUS an hour (fall
 * back), because the boundaries are PFA wall-clock midnights and the elapsed
 * UTC time between them is not a whole number of days. Rounding is what makes
 * "how many days is this period" answer in calendar days rather than in elapsed
 * hours, which is what a human means by the question.
 */
export function payPeriodDays(p: PayPeriod): number {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.round(
    (p.toDateExclusive.getTime() - p.fromDate.getTime()) / MS_PER_DAY,
  );
}

/**
 * Is `d` EXACTLY the first instant of a pay period?
 *
 * SPEC §6.3 — a stipend's effective date must land on a period boundary. A
 * stipend that starts mid-period is not representable under Mark's
 * all-or-nothing rule, so the boundary rejects it loudly instead of silently
 * rounding to a period the admin did not pick.
 *
 * Defined as "equals its OWN period's start" so it can never disagree with
 * `payPeriodFor` — a second hand-written 1st-or-16th check is exactly the kind
 * of duplicate predicate that drifts.
 */
export function isPayPeriodStart(d: Date): boolean {
  assertValidDate(d, "isPayPeriodStart");
  return payPeriodFor(d).fromDate.getTime() === d.getTime();
}

/* ── internals ───────────────────────────────────────────────────────────── */

function buildPayPeriod(
  year: number,
  month: number,
  half: PayPeriodHalf,
): PayPeriod {
  const fromDate = pfaWallClockToUtc(
    `${year}-${pad2(month)}-${half === 1 ? "01" : "16"}`,
    "00:00",
  );
  // P1 ends where the 16th begins. P2 ends where the next month begins — which
  // is what makes the period length fall out of the calendar instead of being
  // asserted, so February and a 31-day month need no special case.
  const toDateExclusive =
    half === 1
      ? pfaWallClockToUtc(`${year}-${pad2(month)}-16`, "00:00")
      : pfaWallClockToUtc(
          month === 12 ? `${year + 1}-01-01` : `${year}-${pad2(month + 1)}-01`,
          "00:00",
        );
  return {
    key: `${year}-${pad2(month)}-P${half}`,
    year,
    month,
    half,
    fromDate,
    toDateExclusive,
  };
}

/** The period's last PFA calendar day: 15, or 28/29/30/31. */
function lastDayOf(p: PayPeriod): number {
  // Back off 1ms from the exclusive end to land inside the final day, the same
  // trick `statementPeriodPresets` uses to turn an exclusive bound into an
  // inclusive display date.
  return pfaParts(new Date(p.toDateExclusive.getTime() - 1)).day;
}

function assertValidDate(d: Date, fn: string): void {
  if (Number.isNaN(d.getTime())) {
    throw new Error(`${fn}: received an invalid Date`);
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
