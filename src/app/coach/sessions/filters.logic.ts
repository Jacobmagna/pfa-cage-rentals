// Pure filter parsing + query-string building for the coach "My sessions"
// history page. Extracted from the server component so it can be unit-tested
// without a DB or a Next request: the page passes raw searchParams in, gets
// back a validated filter set, and uses buildHistoryQuery to construct the
// pagination links that PRESERVE the active filters.
//
// Date bounds stay as "YYYY-MM-DD" strings here (facility-TZ conversion to
// UTC instants happens in the page via parsePfaInput/pfaDayEnd) so this stays
// a pure string module — no Date construction, no timezone math.

/** Use-type values a coach session can carry; anything else is ignored. */
export const VALID_USE_TYPES = new Set(["hitting", "pitching"] as const);

export type HistoryUseType = "hitting" | "pitching";

/** The validated filter set the page builds its WHERE clause from. */
export type HistoryFilters = {
  /** Inclusive lower date bound "YYYY-MM-DD", or null when unset/blank/invalid. */
  from: string | null;
  /** Inclusive upper date bound "YYYY-MM-DD", or null when unset/blank/invalid. */
  to: string | null;
  /** A resourceId validated against the active set, or null. */
  resourceId: string | null;
  /** A valid use-type, or null. */
  useType: HistoryUseType | null;
  /** True when any filter is active (drives the "Clear" affordance). */
  isFiltered: boolean;
};

/** Params keyed off the query string. Each may be string | string[] in Next. */
export type HistoryParamsInput = {
  from?: string | string[];
  to?: string | string[];
  resourceId?: string | string[];
  useType?: string | string[];
};

function pickFirst(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

function isDateInput(v: string | undefined): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/**
 * Validate + normalize the raw query params into a HistoryFilters. The caller
 * supplies the set of valid (active) resource ids so an unknown/stale
 * resourceId in the URL is silently dropped rather than yielding an empty
 * result. Bad dates / unknown use-types collapse to null. Default (nothing
 * supplied) = all sessions, isFiltered=false.
 */
export function parseHistoryFilters(
  input: HistoryParamsInput,
  validResourceIds: ReadonlySet<string>,
): HistoryFilters {
  const fromRaw = pickFirst(input.from);
  const toRaw = pickFirst(input.to);
  const resourceRaw = pickFirst(input.resourceId);
  const useTypeRaw = pickFirst(input.useType);

  const from = isDateInput(fromRaw) ? fromRaw : null;
  const to = isDateInput(toRaw) ? toRaw : null;
  const resourceId =
    resourceRaw && validResourceIds.has(resourceRaw) ? resourceRaw : null;
  const useType =
    useTypeRaw && VALID_USE_TYPES.has(useTypeRaw as HistoryUseType)
      ? (useTypeRaw as HistoryUseType)
      : null;

  const isFiltered =
    from !== null || to !== null || resourceId !== null || useType !== null;

  return { from, to, resourceId, useType, isFiltered };
}

/** Inputs to the query-string builder: the active filters + a target page. */
export type HistoryQueryInput = {
  from?: string | null;
  to?: string | null;
  resourceId?: string | null;
  useType?: string | null;
  page?: number | null;
};

/**
 * Build a `/coach/sessions` query string from the active filters + target page.
 * Empty / null / blank params are omitted; page is omitted when it's 1 or
 * absent (page 1 is the default, no need to clutter the URL). Returns a path
 * with a leading "?" when any param is present, else the bare path — so it can
 * be dropped straight into a pagination href that must PRESERVE the filters.
 *
 * Order is stable (from, to, resourceId, useType, page) so links round-trip
 * predictably and tests can assert exact strings.
 */
export function buildHistoryQuery(input: HistoryQueryInput): string {
  const params = new URLSearchParams();
  const add = (key: string, value: string | null | undefined) => {
    if (value !== null && value !== undefined && value !== "") {
      params.set(key, value);
    }
  };
  add("from", input.from);
  add("to", input.to);
  add("resourceId", input.resourceId);
  add("useType", input.useType);
  if (input.page != null && input.page > 1) {
    params.set("page", String(input.page));
  }
  const qs = params.toString();
  return qs ? `/coach/sessions?${qs}` : "/coach/sessions";
}
