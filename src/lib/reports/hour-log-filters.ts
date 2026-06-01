// Shared filter parsing for the admin hour-log page and its download
// route. Mirrors lib/reports/filters.ts so the page preview and the
// downloaded workbook stay in lock-step (rename a filter once, both
// places update).
//
// Filter shape: a date range (from/to, inclusive) plus an optional
// single coach and single program. Unlike the billing report (which
// multi-selects coaches + resource types), the hour-log surface filters
// by at most one coach and one program — matching the dropdown UI.
//
// Two input shapes:
//   - Next page searchParams: `{ key: string | string[] }` (after await).
//     Hand the resolved object to `normalizeHourLogFilters`.
//   - Route handler: `URL.searchParams`. Use
//     `hourLogFiltersFromURLSearchParams`, which normalizes the shape.

import {
  formatPfaDate,
  parsePfaInput,
  pfaDayEnd,
  pfaMonthEnd,
  pfaMonthStart,
} from "@/lib/timezone";

export type RawHourLogFilterInput = {
  from?: string | string[];
  to?: string | string[];
  coachId?: string | string[];
  programId?: string | string[];
};

export type NormalizedHourLogFilters = {
  /** YYYY-MM-DD start of the inclusive range. */
  from: string;
  /** YYYY-MM-DD end of the inclusive range. */
  to: string;
  /** UTC instant at PFA-midnight on `from` — SQL `gte` lower bound. */
  fromDate: Date;
  /** UTC instant at PFA-midnight on the day AFTER `to` — SQL `lt` upper bound. */
  toDateExclusive: Date;
  /** undefined means "no coach filter" — include everyone. */
  coachId?: string;
  /** undefined means "no program filter" — include all programs. */
  programId?: string;
  /** True if any filter differs from the default (current month, all coaches/programs). */
  isFiltered: boolean;
};

export function normalizeHourLogFilters(
  input: RawHourLogFilterInput,
): NormalizedHourLogFilters {
  // Default range: the current PFA-calendar month. Server UTC clock
  // would otherwise misbucket the first/last day near month boundaries
  // (between PFA-TZ midnight and UTC midnight).
  const now = new Date();
  const defaultFrom = formatPfaDate(pfaMonthStart(now));
  // pfaMonthEnd is the exclusive upper bound (first instant of next
  // month); back up one millisecond so we render the last day of THIS
  // month as the inclusive `to`.
  const lastDayOfMonth = new Date(pfaMonthEnd(now).getTime() - 1);
  const defaultTo = formatPfaDate(lastDayOfMonth);

  const fromCandidate = pickFirst(input.from);
  const toCandidate = pickFirst(input.to);
  const from = isDateInput(fromCandidate) ? fromCandidate : defaultFrom;
  const to = isDateInput(toCandidate) ? toCandidate : defaultTo;

  const coachIdRaw = pickFirst(input.coachId)?.trim();
  const programIdRaw = pickFirst(input.programId)?.trim();
  const coachId = coachIdRaw ? coachIdRaw : undefined;
  const programId = programIdRaw ? programIdRaw : undefined;

  const fromDate = parsePfaInput(from, "00:00");
  // `to` is inclusive — exclusive upper bound is PFA midnight of the
  // following day.
  const toDateExclusive = pfaDayEnd(parsePfaInput(to, "00:00"));

  const isFiltered =
    from !== defaultFrom ||
    to !== defaultTo ||
    coachId !== undefined ||
    programId !== undefined;

  return {
    from,
    to,
    fromDate,
    toDateExclusive,
    coachId,
    programId,
    isFiltered,
  };
}

export function hourLogFiltersFromURLSearchParams(
  sp: URLSearchParams,
): NormalizedHourLogFilters {
  return normalizeHourLogFilters({
    from: sp.get("from") ?? undefined,
    to: sp.get("to") ?? undefined,
    coachId: sp.get("coachId") ?? undefined,
    programId: sp.get("programId") ?? undefined,
  });
}

/**
 * Builds the canonical URL query string for a filter set — used by the
 * page to construct the download link with identical filters.
 */
export function hourLogFiltersToQueryString(
  filters: NormalizedHourLogFilters,
): string {
  const sp = new URLSearchParams();
  sp.set("from", filters.from);
  sp.set("to", filters.to);
  if (filters.coachId) sp.set("coachId", filters.coachId);
  if (filters.programId) sp.set("programId", filters.programId);
  return sp.toString();
}

function pickFirst(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

function isDateInput(v: string | undefined): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}
