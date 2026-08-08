// Shared filter parsing for the admin hour-log page and its download
// route. Mirrors lib/reports/filters.ts so the page preview and the
// downloaded workbook stay in lock-step (rename a filter once, both
// places update).
//
// Filter shape: a date range (from/to, inclusive) plus a coach set and
// an optional single program. The coach filter is a `coachIds: string[]`
// multi-select — the SAME shape lib/reports/filters.ts uses — so the two
// report surfaces can eventually sit under one shared filter bar
// (reports-tabs SPEC §11 decision 1). Empty array means "no coach
// filter — include everyone", exactly as on the cage side.
//
// URL contract (back-compat): the canonical query key is `coachIds`
// (repeatable). The legacy single-value `coachId` key is STILL accepted
// on read, so bookmarks, shared links and in-app deep links such as
// /admin/hour-log?coachId=<id> (src/app/admin/coaches/[id]/page.tsx)
// keep working unchanged. Both keys are merged and de-duplicated.
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
  /** Canonical multi-coach key. Repeatable in a query string. */
  coachIds?: string | string[];
  /**
   * LEGACY single-coach key. Still accepted (and merged into `coachIds`)
   * so pre-existing bookmarks / deep links keep filtering. Do not emit it
   * from new code — `hourLogFiltersToQueryString` writes `coachIds`.
   */
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
  /** Empty array means "no coach filter" — include everyone. */
  coachIds: string[];
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

  // Merge the canonical `coachIds` with the legacy `coachId` key, trim
  // (the single-coach code trimmed, so a whitespace-only value has always
  // meant "no filter"), drop empties, de-dupe. Order is preserved:
  // canonical ids first, then any legacy-only id.
  const coachIds = dedupe(
    [...toArray(input.coachIds), ...toArray(input.coachId)]
      .map((id) => id.trim())
      .filter(Boolean),
  );

  const programIdRaw = pickFirst(input.programId)?.trim();
  const programId = programIdRaw ? programIdRaw : undefined;

  const fromDate = parsePfaInput(from, "00:00");
  // `to` is inclusive — exclusive upper bound is PFA midnight of the
  // following day.
  const toDateExclusive = pfaDayEnd(parsePfaInput(to, "00:00"));

  const isFiltered =
    from !== defaultFrom ||
    to !== defaultTo ||
    coachIds.length > 0 ||
    programId !== undefined;

  return {
    from,
    to,
    fromDate,
    toDateExclusive,
    coachIds,
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
    // getAll on an absent key returns [] — both keys are read so a link
    // carrying the legacy `coachId` still filters.
    coachIds: sp.getAll("coachIds"),
    coachId: sp.getAll("coachId"),
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
  // Canonical key only. Readers accept the legacy `coachId` too, so a
  // link built before this change still resolves the same way.
  for (const id of filters.coachIds) sp.append("coachIds", id);
  if (filters.programId) sp.set("programId", filters.programId);
  return sp.toString();
}

/**
 * Projects the /admin/reports filter bar onto the work-log filter shape,
 * for the Reports "Work hours" tab.
 *
 * The two models converged in Phase A (both carry `coachIds: string[]`),
 * so this is a straight projection — it re-parses nothing and introduces
 * no second source of truth for the date window.
 *
 * `resourceTypes` is deliberately DROPPED rather than translated: work
 * logs are not resource bookings, and coupling the two was the §1(b)
 * defect this whole feature exists to remove.
 *
 * Lives here, not inline in the page, so the tests exercise the projection
 * the page actually uses instead of a copy of it.
 */
export function hourLogFiltersFromReportFilters(
  filters: ReportFilterSlice,
): NormalizedHourLogFilters {
  return {
    from: filters.from,
    to: filters.to,
    fromDate: filters.fromDate,
    toDateExclusive: filters.toDateExclusive,
    coachIds: filters.coachIds,
    programId: filters.programId,
    // Whether the admin narrowed beyond the date range. Nothing on the
    // reports path reads this — it drives the Work Log page's own
    // "filters applied" chrome — but it is part of the shape, so it is
    // computed rather than hardcoded.
    isFiltered: filters.coachIds.length > 0 || filters.programId !== undefined,
  };
}

/**
 * The part of `NormalizedFilters` the work side consumes. Structural, so
 * this module stays free of an import cycle with `filters.ts`.
 */
export type ReportFilterSlice = {
  from: string;
  to: string;
  fromDate: Date;
  toDateExclusive: Date;
  coachIds: string[];
  programId?: string;
};

function pickFirst(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

function toArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function dedupe(ids: string[]): string[] {
  return [...new Set(ids)];
}

function isDateInput(v: string | undefined): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}
