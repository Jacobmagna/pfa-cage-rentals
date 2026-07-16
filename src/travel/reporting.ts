// Block 5a — the OPERATOR FINANCES read layer. Impure aggregation over tables
// that already exist (travel_payments / travel_refunds / travel_invoices /
// travel_installments). Every function is OPERATOR-SCOPE (the operator's global
// view — NO guardian filtering) and the route guards with requireTravelAccess.
//
// READ-ONLY: no writes, no Stripe, no settlement. This is a reporting spine —
// "money collected to the single travel account" — the operator settlement /
// commission engine is a LATER task (this block deliberately does NOT touch
// parties / ledger / commissions).
//
// DRIVER: neon-http (drizzle) — NO db.transaction (read-only anyway). We prefer
// SQL sum()/count()/groupBy over loading rows and folding in JS; the on-time KPI
// is the one place we load a (small, capped) row set and hand it to the pure
// helper in reporting.logic.ts.
//
// MONEY: integer cents everywhere. coalesce(sum(...),0)::int keeps a no-row
// aggregate at 0 (not null) and integer-typed. The route formats to USD for
// display only.

import { and, eq, gte, isNotNull, lt, ne, notInArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { db } from "@/db";
import {
  travelGuardians,
  travelInstallments,
  travelInvoices,
  travelPayments,
  travelProducts,
  travelRefunds,
  travelTeams,
} from "@/db/schema";
import {
  DEFAULT_GRACE_DAYS,
  onTimeBonusTier,
  onTimeCollectionRate,
  parseReportPeriod,
  type OnTimeBonusTier,
} from "@/travel/reporting.logic";

// Statuses that are NOT still-owed (excluded from point-in-time outstanding AR).
const SETTLED_INVOICE_STATUSES = ["paid", "void", "refunded"] as const;

// Defensive cap on the one unbounded row read (installments for the on-time
// KPI). Any realistic travel org is far under this; a runaway set is capped
// rather than loading unboundedly.
const INSTALLMENT_READ_CAP = 1000;

export type ReportPeriodInput = { from?: string; to?: string };

// Build an AND of the period bounds against a timestamp column: `>= fromDate`
// (inclusive) and `< toDate` (exclusive next-day midnight). Returns undefined
// when the period is all-time (no bounds) so a caller can `and(...)` it away.
function inPeriod(
  column: Parameters<typeof gte>[0],
  period: { fromDate: Date | null; toDate: Date | null },
): SQL | undefined {
  const conds: SQL[] = [];
  if (period.fromDate) conds.push(gte(column, period.fromDate));
  if (period.toDate) conds.push(lt(column, period.toDate));
  return conds.length ? and(...conds) : undefined;
}

// Join a guardian first/last into a display name; a fully-null pair (set-null'd
// FK) → null so the UI renders "—". Mirrors catalog.ts's joinName.
function joinName(first: string | null, last: string | null): string | null {
  const name = [first, last].filter(Boolean).join(" ").trim();
  return name.length > 0 ? name : null;
}

// ── Financial summary ────────────────────────────────────────────────────────

export type TravelFinancialSummary = {
  collectedCents: number;
  refundedCents: number;
  netCollectedCents: number;
  billedCents: number;
  outstandingCents: number;
  succeededPaymentCount: number;
  refundCount: number;
};

/**
 * Top-line money for the finances dashboard.
 *   collected      = SUM succeeded payments (paidAt in period).
 *   refunded       = SUM refunds (createdAt in period).
 *   netCollected   = collected − refunded.
 *   billed         = SUM non-void invoices created in period.
 *   outstanding    = SUM invoice balance for invoices NOT in (paid/void/refunded)
 *                    — POINT-IN-TIME (period is intentionally ignored: AR is
 *                    "what is owed right now", not "what was owed in a window").
 */
export async function getTravelFinancialSummary(
  period?: ReportPeriodInput,
): Promise<TravelFinancialSummary> {
  const p = parseReportPeriod(period?.from, period?.to);

  const [collectedRow, refundedRow, billedRow, outstandingRow] =
    await Promise.all([
      db
        .select({
          cents: sql<number>`coalesce(sum(${travelPayments.amountCents}), 0)::int`,
          count: sql<number>`count(*)::int`,
        })
        .from(travelPayments)
        .where(
          and(
            eq(travelPayments.status, "succeeded"),
            inPeriod(travelPayments.paidAt, p),
          ),
        ),
      db
        .select({
          cents: sql<number>`coalesce(sum(${travelRefunds.amountCents}), 0)::int`,
          count: sql<number>`count(*)::int`,
        })
        .from(travelRefunds)
        .where(inPeriod(travelRefunds.createdAt, p)),
      db
        .select({
          cents: sql<number>`coalesce(sum(${travelInvoices.totalCents}), 0)::int`,
        })
        .from(travelInvoices)
        .where(
          and(
            ne(travelInvoices.status, "void"),
            inPeriod(travelInvoices.createdAt, p),
          ),
        ),
      // Point-in-time AR: no period filter (see doc comment above).
      db
        .select({
          cents: sql<number>`coalesce(sum(${travelInvoices.balanceCents}), 0)::int`,
        })
        .from(travelInvoices)
        .where(
          notInArray(travelInvoices.status, [...SETTLED_INVOICE_STATUSES]),
        ),
    ]);

  const collectedCents = collectedRow[0]?.cents ?? 0;
  const refundedCents = refundedRow[0]?.cents ?? 0;

  return {
    collectedCents,
    refundedCents,
    netCollectedCents: collectedCents - refundedCents,
    billedCents: billedRow[0]?.cents ?? 0,
    outstandingCents: outstandingRow[0]?.cents ?? 0,
    succeededPaymentCount: collectedRow[0]?.count ?? 0,
    refundCount: refundedRow[0]?.count ?? 0,
  };
}

// ── Revenue by product / team ────────────────────────────────────────────────

export type TravelRevenueByProduct = {
  productId: string | null;
  productName: string | null;
  teamId: string | null;
  teamName: string | null;
  collectedCents: number;
  refundedCents: number;
  netCents: number;
  invoiceCount: number;
};

/**
 * Net collected per PRODUCT (succeeded payments − refunds, both period-scoped),
 * with the product's team resolved. Two grouped queries (collected-by-product,
 * refunded-by-product) merged in JS on productId; a payment whose invoice has a
 * set-null'd product falls into a single null-product bucket. Sorted netCents
 * desc. invoiceCount = distinct invoices that contributed a succeeded payment.
 */
export async function getTravelRevenueByProduct(
  period?: ReportPeriodInput,
): Promise<TravelRevenueByProduct[]> {
  const p = parseReportPeriod(period?.from, period?.to);

  const [collected, refunded] = await Promise.all([
    db
      .select({
        productId: travelProducts.id,
        productName: travelProducts.name,
        teamId: travelProducts.teamId,
        teamName: travelTeams.name,
        cents: sql<number>`coalesce(sum(${travelPayments.amountCents}), 0)::int`,
        invoiceCount: sql<number>`count(distinct ${travelPayments.invoiceId})::int`,
      })
      .from(travelPayments)
      .leftJoin(travelInvoices, eq(travelInvoices.id, travelPayments.invoiceId))
      .leftJoin(travelProducts, eq(travelProducts.id, travelInvoices.productId))
      .leftJoin(travelTeams, eq(travelTeams.id, travelProducts.teamId))
      .where(
        and(
          eq(travelPayments.status, "succeeded"),
          inPeriod(travelPayments.paidAt, p),
        ),
      )
      .groupBy(
        travelProducts.id,
        travelProducts.name,
        travelProducts.teamId,
        travelTeams.name,
      ),
    db
      .select({
        productId: travelProducts.id,
        productName: travelProducts.name,
        teamId: travelProducts.teamId,
        teamName: travelTeams.name,
        cents: sql<number>`coalesce(sum(${travelRefunds.amountCents}), 0)::int`,
      })
      .from(travelRefunds)
      .leftJoin(travelPayments, eq(travelPayments.id, travelRefunds.paymentId))
      .leftJoin(travelInvoices, eq(travelInvoices.id, travelPayments.invoiceId))
      .leftJoin(travelProducts, eq(travelProducts.id, travelInvoices.productId))
      .leftJoin(travelTeams, eq(travelTeams.id, travelProducts.teamId))
      .where(inPeriod(travelRefunds.createdAt, p))
      .groupBy(
        travelProducts.id,
        travelProducts.name,
        travelProducts.teamId,
        travelTeams.name,
      ),
  ]);

  // Merge on productId (null → a single shared bucket keyed "__none__").
  const key = (id: string | null) => id ?? "__none__";
  const rows = new Map<string, TravelRevenueByProduct>();

  for (const c of collected) {
    rows.set(key(c.productId), {
      productId: c.productId,
      productName: c.productName,
      teamId: c.teamId,
      teamName: c.teamName,
      collectedCents: c.cents,
      refundedCents: 0,
      netCents: c.cents,
      invoiceCount: c.invoiceCount,
    });
  }
  for (const r of refunded) {
    const k = key(r.productId);
    const existing = rows.get(k);
    if (existing) {
      existing.refundedCents = r.cents;
      existing.netCents = existing.collectedCents - r.cents;
    } else {
      // Refund in period whose product had no succeeded payment in period.
      rows.set(k, {
        productId: r.productId,
        productName: r.productName,
        teamId: r.teamId,
        teamName: r.teamName,
        collectedCents: 0,
        refundedCents: r.cents,
        netCents: -r.cents,
        invoiceCount: 0,
      });
    }
  }

  return [...rows.values()].sort((a, b) => b.netCents - a.netCents);
}

export type TravelRevenueByTeam = {
  teamId: string | null;
  teamName: string; // resolved bucket label (never null — unassigned → a label)
  collectedCents: number;
  refundedCents: number;
  netCents: number;
  invoiceCount: number;
};

// Bucket label for products with no team (set-null'd or never assigned).
export const UNASSIGNED_TEAM_LABEL = "No team / unassigned";

/**
 * The by-product rows folded up to TEAM. Products with no team collapse into a
 * single "No team / unassigned" bucket. Sorted netCents desc. Built off
 * getTravelRevenueByProduct so the two views can never drift.
 */
export async function getTravelRevenueByTeam(
  period?: ReportPeriodInput,
): Promise<TravelRevenueByTeam[]> {
  const products = await getTravelRevenueByProduct(period);

  const key = (id: string | null) => id ?? "__none__";
  const rows = new Map<string, TravelRevenueByTeam>();

  for (const prod of products) {
    const k = key(prod.teamId);
    const existing = rows.get(k);
    if (existing) {
      existing.collectedCents += prod.collectedCents;
      existing.refundedCents += prod.refundedCents;
      existing.netCents += prod.netCents;
      existing.invoiceCount += prod.invoiceCount;
    } else {
      rows.set(k, {
        teamId: prod.teamId,
        teamName: prod.teamName ?? UNASSIGNED_TEAM_LABEL,
        collectedCents: prod.collectedCents,
        refundedCents: prod.refundedCents,
        netCents: prod.netCents,
        invoiceCount: prod.invoiceCount,
      });
    }
  }

  return [...rows.values()].sort((a, b) => b.netCents - a.netCents);
}

// ── Revenue by family (guardian) ─────────────────────────────────────────────

export type TravelRevenueByFamily = {
  guardianId: string | null;
  guardianName: string | null;
  collectedCents: number;
  netCents: number;
  outstandingCents: number;
};

/**
 * Net collected + still-owed per FAMILY (guardian). collected = succeeded
 * payments (period), refunded = refunds joined back to the payment's guardian
 * (period), net = collected − refunded. outstanding = POINT-IN-TIME sum of that
 * guardian's non-settled invoice balances (period ignored, same as the summary
 * AR). Merged in JS across three grouped queries; sorted netCents desc.
 */
export async function getTravelRevenueByFamily(
  period?: ReportPeriodInput,
): Promise<TravelRevenueByFamily[]> {
  const p = parseReportPeriod(period?.from, period?.to);

  const [collected, refunded, outstanding] = await Promise.all([
    db
      .select({
        guardianId: travelPayments.guardianId,
        firstName: travelGuardians.firstName,
        lastName: travelGuardians.lastName,
        cents: sql<number>`coalesce(sum(${travelPayments.amountCents}), 0)::int`,
      })
      .from(travelPayments)
      .leftJoin(
        travelGuardians,
        eq(travelGuardians.id, travelPayments.guardianId),
      )
      .where(
        and(
          eq(travelPayments.status, "succeeded"),
          inPeriod(travelPayments.paidAt, p),
        ),
      )
      .groupBy(
        travelPayments.guardianId,
        travelGuardians.firstName,
        travelGuardians.lastName,
      ),
    db
      .select({
        guardianId: travelPayments.guardianId,
        cents: sql<number>`coalesce(sum(${travelRefunds.amountCents}), 0)::int`,
      })
      .from(travelRefunds)
      .leftJoin(travelPayments, eq(travelPayments.id, travelRefunds.paymentId))
      .where(inPeriod(travelRefunds.createdAt, p))
      .groupBy(travelPayments.guardianId),
    db
      .select({
        guardianId: travelInvoices.guardianId,
        firstName: travelGuardians.firstName,
        lastName: travelGuardians.lastName,
        cents: sql<number>`coalesce(sum(${travelInvoices.balanceCents}), 0)::int`,
      })
      .from(travelInvoices)
      .leftJoin(
        travelGuardians,
        eq(travelGuardians.id, travelInvoices.guardianId),
      )
      .where(
        notInArray(travelInvoices.status, [...SETTLED_INVOICE_STATUSES]),
      )
      .groupBy(
        travelInvoices.guardianId,
        travelGuardians.firstName,
        travelGuardians.lastName,
      ),
  ]);

  const key = (id: string | null) => id ?? "__none__";
  const rows = new Map<
    string,
    TravelRevenueByFamily & { refundedCents: number }
  >();

  const ensure = (
    id: string | null,
    name: string | null,
  ): TravelRevenueByFamily & { refundedCents: number } => {
    const k = key(id);
    let row = rows.get(k);
    if (!row) {
      row = {
        guardianId: id,
        guardianName: name,
        collectedCents: 0,
        netCents: 0,
        outstandingCents: 0,
        refundedCents: 0,
      };
      rows.set(k, row);
    } else if (row.guardianName === null && name !== null) {
      row.guardianName = name; // backfill a name a later query supplies
    }
    return row;
  };

  for (const c of collected) {
    const row = ensure(c.guardianId, joinName(c.firstName, c.lastName));
    row.collectedCents += c.cents;
  }
  for (const r of refunded) {
    const row = ensure(r.guardianId, null);
    row.refundedCents += r.cents;
  }
  for (const o of outstanding) {
    const row = ensure(o.guardianId, joinName(o.firstName, o.lastName));
    row.outstandingCents += o.cents;
  }

  return [...rows.values()]
    .map((r) => ({
      guardianId: r.guardianId,
      guardianName: r.guardianName,
      collectedCents: r.collectedCents,
      netCents: r.collectedCents - r.refundedCents,
      outstandingCents: r.outstandingCents,
    }))
    .sort((a, b) => b.netCents - a.netCents);
}

// ── On-time collection KPI ───────────────────────────────────────────────────

export type TravelOnTimeCollection = {
  dueCount: number;
  onTimeCount: number;
  ratePct: number | null;
  tier: OnTimeBonusTier;
};

/**
 * On-time collection rate over installments whose dueDate falls in the period.
 * Loads the (small, capped) due-installment set and hands it to the pure
 * onTimeCollectionRate helper (grace = DEFAULT_GRACE_DAYS), then labels the
 * bonus tier. This is a KPI display only — the actual bonus payout engine is a
 * later task.
 */
export async function getTravelOnTimeCollection(
  period?: ReportPeriodInput,
): Promise<TravelOnTimeCollection> {
  const p = parseReportPeriod(period?.from, period?.to);

  // Only installments WITH a due date can be "due"; period-scope by dueDate.
  const installments = await db
    .select({
      dueDate: travelInstallments.dueDate,
      paidDate: travelInstallments.paidDate,
    })
    .from(travelInstallments)
    .where(
      and(
        isNotNull(travelInstallments.dueDate),
        inPeriod(travelInstallments.dueDate, p),
      ),
    )
    .limit(INSTALLMENT_READ_CAP);

  const rate = onTimeCollectionRate(installments, DEFAULT_GRACE_DAYS);
  return { ...rate, tier: onTimeBonusTier(rate.ratePct) };
}
