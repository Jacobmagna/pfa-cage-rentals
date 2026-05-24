// Shared filter parsing for the /admin/audit page.
// Mirrors the lib/reports/filters.ts pattern: pure normalization
// against URL searchParams so the page is shareable + back-button
// friendly.

const VALID_ENTITY_TYPES = new Set([
  "session",
  "block",
  "rate_override",
]);

export type EntityType = "session" | "block" | "rate_override";

const VALID_ACTIONS = new Set(["create", "update", "delete"]);
export type AuditAction = "create" | "update" | "delete";

export type RawAuditFilterInput = {
  from?: string | string[];
  to?: string | string[];
  actorId?: string | string[];
  entityTypes?: string | string[];
  actions?: string | string[];
  page?: string | string[];
};

export type NormalizedAuditFilters = {
  from: string;
  to: string;
  /** Local-midnight Date for SQL `gte`. */
  fromDate: Date;
  /** One day past `to`, exclusive. */
  toDateExclusive: Date;
  /** Empty means "all actors". */
  actorId: string | null;
  /** Empty means "all entity types". */
  entityTypes: EntityType[];
  /** Empty means "all actions". */
  actions: AuditAction[];
  /** 1-indexed; clamped to >=1. */
  page: number;
};

export const AUDIT_PAGE_SIZE = 50;

export function normalizeAuditFilters(
  input: RawAuditFilterInput,
): NormalizedAuditFilters {
  // Default range: last 7 days (matches "what changed this week"
  // mental model). Reports defaults to month; audit log is more
  // about recent activity.
  const today = new Date();
  const defaultTo = formatDateInput(today);
  const sevenDaysAgo = new Date(today);
  sevenDaysAgo.setDate(today.getDate() - 6);
  const defaultFrom = formatDateInput(sevenDaysAgo);

  const fromCandidate = pickFirst(input.from);
  const toCandidate = pickFirst(input.to);
  const from = isDateInput(fromCandidate) ? fromCandidate : defaultFrom;
  const to = isDateInput(toCandidate) ? toCandidate : defaultTo;

  const actorId = pickFirst(input.actorId) || null;

  const entityTypes = toArray(input.entityTypes).filter(
    (t): t is EntityType => VALID_ENTITY_TYPES.has(t),
  );
  const actions = toArray(input.actions).filter(
    (a): a is AuditAction => VALID_ACTIONS.has(a),
  );

  const pageParsed = Number(pickFirst(input.page));
  const page =
    Number.isFinite(pageParsed) && pageParsed >= 1 ? Math.floor(pageParsed) : 1;

  const fromDate = parseDateInput(from);
  const toDateExclusive = parseDateInput(to);
  toDateExclusive.setDate(toDateExclusive.getDate() + 1);

  return {
    from,
    to,
    fromDate,
    toDateExclusive,
    actorId,
    entityTypes,
    actions,
    page,
  };
}

/**
 * Builds the canonical URL query string for a filter set. Used to
 * construct pagination links that preserve the filter.
 */
export function auditFiltersToQueryString(
  filters: NormalizedAuditFilters,
  overrides: { page?: number } = {},
): string {
  const sp = new URLSearchParams();
  sp.set("from", filters.from);
  sp.set("to", filters.to);
  if (filters.actorId) sp.set("actorId", filters.actorId);
  for (const t of filters.entityTypes) sp.append("entityTypes", t);
  for (const a of filters.actions) sp.append("actions", a);
  const page = overrides.page ?? filters.page;
  if (page > 1) sp.set("page", String(page));
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
