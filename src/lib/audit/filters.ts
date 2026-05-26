// Shared filter parsing for the /admin/audit page.
// Mirrors the lib/reports/filters.ts pattern: pure normalization
// against URL searchParams so the page is shareable + back-button
// friendly.

import { formatPfaDate, parsePfaInput, pfaDayEnd } from "@/lib/timezone";

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
  /** UTC instant at PFA-midnight on `from` — SQL `gte` lower bound. */
  fromDate: Date;
  /** UTC instant at PFA-midnight on the day AFTER `to` — SQL `lt` upper bound. */
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
  // Default range: last 7 PFA days, ending today (matches "what
  // changed this week" mental model). Server UTC clock would otherwise
  // misbucket the boundary day between PFA midnight and UTC midnight.
  const now = new Date();
  const defaultTo = formatPfaDate(now);
  // Walk back 6 PFA-days. Using setDate on a date constructed from
  // PFA parts so DST doesn't drift the boundary.
  const sixDaysBackInstant = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
  const defaultFrom = formatPfaDate(sixDaysBackInstant);

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

  const fromDate = parsePfaInput(from, "00:00");
  // `to` is inclusive — exclusive upper bound is PFA midnight of the
  // following day.
  const toDateExclusive = pfaDayEnd(parsePfaInput(to, "00:00"));

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
