// Block 5b — PURE helpers for the operator MASTER PLAYER LIST. No DB, no network:
// the dues fold over an athlete's invoices and the case-insensitive search-match
// predicate. The impure layer (src/travel/roster-report.ts) batches the DB reads
// and hands per-athlete slices to these functions; this module holds only the
// deterministic math/matching so it can be unit-tested without a database.
//
// MONEY DISCIPLINE: integer cents only. The dues fold never divides — it sums
// integer columns — so the results stay integer-typed; the route formats to USD
// for display only.

// Invoice statuses that are NOT still-owed (excluded from outstanding AR) — the
// same set the finances/billing layers use.
const SETTLED_INVOICE_STATUSES = new Set<string>(["paid", "void", "refunded"]);

// Void invoices are excluded from BILLED/COLLECTED entirely (a void invoice was
// never really owed, so it neither bills nor collects).
const VOID_STATUS = "void";

export type DuesInvoiceInput = {
  totalCents: number;
  balanceCents: number;
  status: string;
};

export type DuesFold = {
  billedCents: number;
  collectedCents: number;
  outstandingCents: number;
  invoiceStatuses: string[];
};

/**
 * Fold one athlete's invoices into their dues totals. PURE.
 *   billed      = SUM(totalCents) over NON-VOID invoices.
 *   collected   = SUM(totalCents − balanceCents) over NON-VOID invoices
 *                 (billed minus what is still owed on those invoices).
 *   outstanding = SUM(balanceCents) over invoices whose status is NOT
 *                 paid/void/refunded (point-in-time "owed right now").
 *   invoiceStatuses = the distinct statuses across ALL the athlete's invoices,
 *                 sorted for a stable display order.
 * An athlete with no invoices → all zero / empty.
 */
export function foldDues(invoices: DuesInvoiceInput[]): DuesFold {
  let billedCents = 0;
  let collectedCents = 0;
  let outstandingCents = 0;
  const statuses = new Set<string>();

  for (const inv of invoices) {
    statuses.add(inv.status);
    if (inv.status !== VOID_STATUS) {
      billedCents += inv.totalCents;
      collectedCents += inv.totalCents - inv.balanceCents;
    }
    if (!SETTLED_INVOICE_STATUSES.has(inv.status)) {
      outstandingCents += inv.balanceCents;
    }
  }

  return {
    billedCents,
    collectedCents,
    outstandingCents,
    invoiceStatuses: [...statuses].sort(),
  };
}

/**
 * Join a first/last into a display name; a fully-empty pair → "" so callers can
 * decide the fallback. PURE. Mirrors the joinName used across the travel layer.
 */
export function formatPlayerName(
  first: string | null,
  last: string | null,
): string {
  return [first, last].filter(Boolean).join(" ").trim();
}

// The minimal row shape the search predicate needs — a subset of the full
// master row, so a partially-built row (or a test fixture) can be matched.
export type SearchableRow = {
  athleteName: string;
  teams: { teamName: string }[];
  guardians: { guardianName: string; email: string }[];
};

/**
 * Case-insensitive match of a raw search query against a player row: true when
 * the query is a substring of the athlete name, ANY team name, ANY guardian
 * name, or ANY guardian email. An empty/whitespace query matches everything
 * (the caller typically skips filtering in that case). PURE.
 */
export function matchesPlayerSearch(
  row: SearchableRow,
  rawQuery: string,
): boolean {
  const q = rawQuery.trim().toLowerCase();
  if (q.length === 0) return true;

  if (row.athleteName.toLowerCase().includes(q)) return true;
  for (const team of row.teams) {
    if (team.teamName.toLowerCase().includes(q)) return true;
  }
  for (const g of row.guardians) {
    if (g.guardianName.toLowerCase().includes(q)) return true;
    if (g.email.toLowerCase().includes(q)) return true;
  }
  return false;
}
