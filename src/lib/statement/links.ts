// payment-statement SPEC §8 / §5.0 — every link the Statements tab emits.
//
// One builder, because every one of these links has the SAME obligation: carry
// the filters that are currently on screen. Switching account, jumping from a
// roster row into a statement, and tapping a month chip are all "the same view,
// one thing changed" — and a link that quietly dropped the coach set or the
// resource types would show a different period or a different scope than the
// filter bar above it still claims.
//
// 🔴 `filtersToQueryString` deliberately emits NO `tab` (see reports/filters.ts:
// the download workbook must never inherit one), so `tab` is appended HERE and
// exactly once. `account` is appended the same way and for the same reason it is
// not in `NormalizedFilters`: it selects which of two computed statements is
// displayed and must never be able to narrow a query.

import {
  filtersToQueryString,
  type NormalizedFilters,
} from "@/lib/reports/filters";
import type { StatementAccount } from "./types";

export type StatementLinkOverrides = {
  /**
   * Replaces the coach scope. Used by a roster row's `Statement →`, which is
   * "these filters, narrowed to this one coach" — the narrowing that flips the
   * tab from the roll-up to a single document (SPEC §8.1).
   */
  coachIds?: string[];
  /** Replaces the period. Used by the month chips (SPEC §6). */
  from?: string;
  to?: string;
};

/**
 * `/admin/reports?<current filters>&tab=statements&account=…`
 *
 * Overrides are applied to a COPY of the filters, so a caller cannot mutate the
 * page's own filter object while building a link.
 */
export function statementHref(
  filters: NormalizedFilters,
  account: StatementAccount,
  overrides: StatementLinkOverrides = {},
): string {
  const scoped: NormalizedFilters = {
    ...filters,
    coachIds: overrides.coachIds ?? filters.coachIds,
    from: overrides.from ?? filters.from,
    to: overrides.to ?? filters.to,
  };
  // `fromDate` / `toDateExclusive` are deliberately NOT recomputed from an
  // overridden `from` / `to` here. They would be a second parse of the same
  // boundary, and nothing downstream of a URL reads them — the next request
  // re-derives them through `normalizeFilters`, the one parser on this path.
  return `/admin/reports?${filtersToQueryString(scoped)}&tab=statements&account=${account}`;
}
