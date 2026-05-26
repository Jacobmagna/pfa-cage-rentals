// Shared filter parsing for the report page and the download route.
// Two call sites would otherwise duplicate ~30 lines of "parse +
// validate + default" each — extracting here keeps the contract
// honest (rename a filter once, both places update).
//
// Two input shapes:
//   - Next page searchParams: `Promise<{ key: string | string[] }>`
//     The page does `await searchParams` then hands the resolved
//     object to `normalizeFilters`.
//   - Route handler: `URL.searchParams` (the standard Web API).
//     Use `filtersFromURLSearchParams` which normalizes the shape.

import type { ResourceType } from "@/lib/billing";
import {
  formatPfaDate,
  parsePfaInput,
  pfaDayEnd,
  pfaMonthEnd,
  pfaMonthStart,
} from "@/lib/timezone";

export type RawFilterInput = {
  from?: string | string[];
  to?: string | string[];
  coachIds?: string | string[];
  resourceTypes?: string | string[];
};

export type NormalizedFilters = {
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
  /** Empty array means "no resource type filter" — include all three. */
  resourceTypes: ResourceType[];
};

const VALID_RESOURCE_TYPES = new Set<ResourceType>([
  "cage",
  "bullpen",
  "weight_room",
]);

export function normalizeFilters(input: RawFilterInput): NormalizedFilters {
  // Default range: the current PFA-calendar month. Server UTC clock
  // would otherwise misbucket the first/last day near month boundaries
  // (between PFA-TZ midnight and UTC midnight).
  const now = new Date();
  const defaultFrom = formatPfaDate(pfaMonthStart(now));
  // pfaMonthEnd is the exclusive upper bound (first instant of next
  // month); back up one PFA-day so we render the last day of THIS month
  // as the inclusive `to`.
  const lastDayOfMonth = new Date(pfaMonthEnd(now).getTime() - 1);
  const defaultTo = formatPfaDate(lastDayOfMonth);

  const fromCandidate = pickFirst(input.from);
  const toCandidate = pickFirst(input.to);
  const from = isDateInput(fromCandidate) ? fromCandidate : defaultFrom;
  const to = isDateInput(toCandidate) ? toCandidate : defaultTo;

  const coachIds = toArray(input.coachIds).filter(Boolean);
  const resourceTypes = toArray(input.resourceTypes).filter(
    (t): t is ResourceType => VALID_RESOURCE_TYPES.has(t as ResourceType),
  );

  const fromDate = parsePfaInput(from, "00:00");
  // `to` is inclusive — exclusive upper bound is PFA midnight of the
  // following day.
  const toDateExclusive = pfaDayEnd(parsePfaInput(to, "00:00"));

  return { from, to, fromDate, toDateExclusive, coachIds, resourceTypes };
}

export function filtersFromURLSearchParams(
  sp: URLSearchParams,
): NormalizedFilters {
  return normalizeFilters({
    from: sp.get("from") ?? undefined,
    to: sp.get("to") ?? undefined,
    coachIds: sp.getAll("coachIds"),
    resourceTypes: sp.getAll("resourceTypes"),
  });
}

/**
 * Builds the canonical URL query string for a filter set — used by
 * the page to construct the download link with identical filters.
 */
export function filtersToQueryString(filters: NormalizedFilters): string {
  const sp = new URLSearchParams();
  sp.set("from", filters.from);
  sp.set("to", filters.to);
  for (const id of filters.coachIds) sp.append("coachIds", id);
  for (const t of filters.resourceTypes) sp.append("resourceTypes", t);
  return sp.toString();
}

function pickFirst(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

function toArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function isDateInput(v: string | undefined): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}
