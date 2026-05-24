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
  /** Local-midnight Date for SQL `gte`. */
  fromDate: Date;
  /** Local-midnight Date for SQL `lt` — one day past `to` (exclusive upper). */
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
  const today = new Date();
  const defaultFrom = formatDateInput(
    new Date(today.getFullYear(), today.getMonth(), 1),
  );
  const defaultTo = formatDateInput(
    new Date(today.getFullYear(), today.getMonth() + 1, 0),
  );

  const fromCandidate = pickFirst(input.from);
  const toCandidate = pickFirst(input.to);
  const from = isDateInput(fromCandidate) ? fromCandidate : defaultFrom;
  const to = isDateInput(toCandidate) ? toCandidate : defaultTo;

  const coachIds = toArray(input.coachIds).filter(Boolean);
  const resourceTypes = toArray(input.resourceTypes).filter(
    (t): t is ResourceType => VALID_RESOURCE_TYPES.has(t as ResourceType),
  );

  const fromDate = parseDateInput(from);
  const toDateExclusive = parseDateInput(to);
  toDateExclusive.setDate(toDateExclusive.getDate() + 1);

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

function parseDateInput(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function formatDateInput(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
