// Data fetch for the Reports "Payments" timeline. Kept separate from
// payments-timeline.ts so the event-shaping logic stays a pure,
// unit-testable module with no DB dependency.
//
// Scope: `entityType = 'payment'` only. NOT a general money-audit feed —
// re-prices, held-log approvals and rate changes stay out of v1 (SPEC §11
// decision 3). They already write `audit_log` rows, so widening later is
// purely additive.
//
// Indexes: `audit_log_entity_idx` is on (entity_type, entity_id), so an
// `entity_type = 'payment'` predicate is served by its LEADING column;
// `audit_log_ts_idx` serves the range + the ordering. No new index.
//
// ⚠️ `audit_log.ts` is `timestamp` WITHOUT time zone. Range-filtering it
// with JS Dates through Drizzle is established, shipped behavior — see
// `src/lib/audit/fetch.ts`, which does exactly this for the audit viewer.
// The danger this repo has been bitten by twice is RAW `sql` reads, which
// bypass Drizzle's column parser and hand back a tz-naive string. There
// is deliberately no raw SQL here, and
// tests/integration/reports-payments-timeline.test.ts pins the round trip.

import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { auditLog, coachPayments, users } from "@/db/schema";
import type { PaymentAuditRow } from "./payments-timeline";

/** The filter slice this fetch consumes — the report bar's shared fields. */
export type PaymentTimelineFilters = {
  fromDate: Date;
  toDateExclusive: Date;
  /** Empty = every coach. */
  coachIds: string[];
};

/**
 * A hard cap so one enormous range cannot render an unbounded page. If a
 * result is truncated the UI SAYS SO — a silently shortened money
 * timeline reads as "that's everything that happened", which is worse
 * than no timeline at all.
 */
export const PAYMENT_TIMELINE_LIMIT = 500;

export type PaymentTimelineFetchResult = {
  rows: PaymentAuditRow[];
  /** True when more events matched than the limit returned. */
  truncated: boolean;
};

export async function fetchPaymentTimelineRows(
  filters: PaymentTimelineFilters,
): Promise<PaymentTimelineFetchResult> {
  // The coach who RECEIVED/MADE the payment. Aliased because `users` is
  // already joined once for the actor.
  const coach = alias(users, "timeline_coach");

  const conditions = [
    eq(auditLog.entityType, "payment"),
    gte(auditLog.ts, filters.fromDate),
    lt(auditLog.ts, filters.toDateExclusive),
  ];
  if (filters.coachIds.length > 0) {
    conditions.push(inArray(coachPayments.coachId, filters.coachIds));
  }

  const rows = await db
    .select({
      id: auditLog.id,
      ts: auditLog.ts,
      action: auditLog.action,
      entityId: auditLog.entityId,
      diff: auditLog.diff,
      actorName: users.name,
      actorEmail: users.email,
      coachName: coach.name,
      coachEmail: coach.email,
      paymentAmountCents: coachPayments.amountCents,
      paymentDirection: coachPayments.direction,
      paymentDeletedAt: coachPayments.deletedAt,
      // The payment's CURRENT values, to seed the existing edit dialog.
      // `updatePayment` always acts on live state, so the form must open
      // showing live state — seeding it from a historical snapshot would
      // let an admin "save" an old value back over a newer one without
      // realising.
      paymentCoachId: coachPayments.coachId,
      paymentMethod: coachPayments.method,
      paymentPaidAt: coachPayments.paidAt,
      paymentCoversThrough: coachPayments.coversThrough,
      paymentReference: coachPayments.reference,
      paymentNote: coachPayments.note,
    })
    .from(auditLog)
    // leftJoin throughout, for the reason lib/audit/fetch.ts documents: an
    // innerJoin would silently DROP history whenever its join target is
    // missing. Here that matters twice over — a hard-deleted actor, or a
    // payment row that no longer exists, would erase the very events that
    // record what happened to the money.
    .leftJoin(users, eq(auditLog.actorUserId, users.id))
    .leftJoin(coachPayments, eq(auditLog.entityId, coachPayments.id))
    .leftJoin(coach, eq(coachPayments.coachId, coach.id))
    .where(and(...conditions))
    .orderBy(desc(auditLog.ts))
    .limit(PAYMENT_TIMELINE_LIMIT + 1);

  return {
    rows: rows.slice(0, PAYMENT_TIMELINE_LIMIT),
    truncated: rows.length > PAYMENT_TIMELINE_LIMIT,
  };
}
