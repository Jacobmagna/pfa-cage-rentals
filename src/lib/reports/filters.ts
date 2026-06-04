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
  /** Hidden marker: present means the scope checkboxes were submitted. */
  scopeApplied?: string | string[];
  includeCage?: string | string[];
  includeProgram?: string | string[];
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
  /**
   * Scope: whether to include cage/bullpen/weight-room session billing
   * (money the coach owes PFA). Default true on a fresh load.
   */
  includeCageSessions: boolean;
  /**
   * Scope: whether to include program hours (coach pay). Default true on
   * a fresh load. Still gated separately by resource-type narrowing.
   */
  includeProgramHours: boolean;
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

  // Scope checkboxes. A GET form submits nothing for unchecked boxes,
  // which is indistinguishable from a fresh load. The hidden
  // `scopeApplied` marker disambiguates: when present, an absent
  // checkbox means "explicitly off"; when absent (fresh load), both
  // categories default on.
  const scopeApplied = present(input.scopeApplied);
  const includeCageSessions = scopeApplied ? present(input.includeCage) : true;
  const includeProgramHours = scopeApplied
    ? present(input.includeProgram)
    : true;

  return {
    from,
    to,
    fromDate,
    toDateExclusive,
    coachIds,
    resourceTypes,
    includeCageSessions,
    includeProgramHours,
  };
}

/**
 * A query param "counts as present" when it was submitted with a
 * non-empty value. Mirrors HTML checkbox semantics: a checked box with
 * `value="1"` submits `"1"`; an unchecked box submits nothing.
 */
function present(v: string | string[] | undefined): boolean {
  if (v === undefined) return false;
  return Array.isArray(v) ? v.length > 0 : v !== "";
}

export function filtersFromURLSearchParams(
  sp: URLSearchParams,
): NormalizedFilters {
  return normalizeFilters({
    from: sp.get("from") ?? undefined,
    to: sp.get("to") ?? undefined,
    coachIds: sp.getAll("coachIds"),
    resourceTypes: sp.getAll("resourceTypes"),
    scopeApplied: sp.get("scopeApplied") ?? undefined,
    includeCage: sp.get("includeCage") ?? undefined,
    includeProgram: sp.get("includeProgram") ?? undefined,
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
  // Always emit the scope marker so the round-trip is unambiguous, then
  // each included category only when on (mirroring checkbox submit).
  sp.set("scopeApplied", "1");
  if (filters.includeCageSessions) sp.set("includeCage", "1");
  if (filters.includeProgramHours) sp.set("includeProgram", "1");
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
