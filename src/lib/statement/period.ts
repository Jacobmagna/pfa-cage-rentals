// payment-statement SPEC §6 — THE PERIOD PICKER, as PRESETS over the from/to
// that already exists.
//
// `[ Jun ][ Jul ][ Aug ]` — the current PFA month and the two prior. Not 12
// real month tabs: those are ugly, they need a year selector, and they break at
// the year boundary. And not a second date model either — each chip resolves to
// the SAME `{from, to}` pair the filter bar's two `DateInput`s produce, so a tap
// and a typed date submit identically. That is the `RepeatsUntilPresets` idiom
// (`admin/schedule/_components/repeats-until-presets.tsx`): chips plus a custom
// fallback, ONE emitted value shape.
//
// Pure and clock-injected. `now` is a parameter rather than a `new Date()` call
// so the year-boundary case (January's two prior months live in the previous
// year) is testable with a literal instead of a mock.
//
// 🔴 Months are resolved through `pfaMonthRange`, which is already PFA-pinned
// and already shipped. Deriving month bounds from the server's UTC clock would
// misbucket the first and last day of every month between PFA midnight and UTC
// midnight — and a month boundary is the one boundary this whole feature turns
// on (SPEC §12.6).

import {
  PFA_TIMEZONE,
  formatPfaDate,
  pfaMonthRange,
  pfaParts,
} from "@/lib/timezone";

/** How many chips: this PFA month plus the two before it (SPEC §6). */
const PRESET_MONTHS = 3;

export type StatementPeriodPreset = {
  /** "Jul", or "Dec 2025" when the month is not in the current PFA year. */
  label: string;
  /** YYYY-MM-DD, the inclusive first day — the filter bar's `from`. */
  from: string;
  /** YYYY-MM-DD, the inclusive last day — the filter bar's `to`. */
  to: string;
};

/**
 * The three month presets, OLDEST FIRST so they read left-to-right as a
 * timeline (`Jun Jul Aug`), matching the design and the way Mark scans a
 * statement's period.
 */
export function statementPeriodPresets(now: Date): StatementPeriodPreset[] {
  const today = pfaParts(now);
  const presets: StatementPeriodPreset[] = [];

  for (let back = PRESET_MONTHS - 1; back >= 0; back -= 1) {
    // Zero-based month arithmetic so December → January wraps without a
    // special case; `pfaParts.month` is 1-indexed.
    const zeroBased = today.month - 1 - back;
    const year = today.year + Math.floor(zeroBased / 12);
    const month = ((zeroBased % 12) + 12) % 12 + 1;

    const { startUtc, endUtc } = pfaMonthRange(
      `${year}-${pad2(month)}-01`,
    );
    presets.push({
      // Back off 1ms from the exclusive end to land on the month's last PFA
      // day — the same trick `normalizeFilters` uses to turn `pfaMonthEnd`
      // into an inclusive `to`, so the chip and the default period agree
      // exactly rather than approximately.
      label: monthLabel(startUtc, today.year),
      from: formatPfaDate(startUtc),
      to: formatPfaDate(new Date(endUtc.getTime() - 1)),
    });
  }

  return presets;
}

/**
 * "Jul" for a month in the current PFA year, "Dec 2025" otherwise.
 *
 * The year is not decoration: in January the two prior chips are November and
 * December of the PREVIOUS year, and three bare month names spanning a year
 * boundary is a statement period the reader can misread by twelve months. It is
 * omitted in the common case because a chip strip that repeats the current year
 * three times is noise.
 */
function monthLabel(startUtc: Date, currentYear: number): string {
  const parts = pfaParts(startUtc);
  const month = startUtc.toLocaleDateString("en-US", {
    timeZone: PFA_TIMEZONE,
    month: "short",
  });
  return parts.year === currentYear ? month : `${month} ${parts.year}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
