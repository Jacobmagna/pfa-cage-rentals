// DB read for the "Payment history" list on /admin/payments. Kept apart from
// history.ts so the paging rules stay a pure, unit-testable module with no DB
// dependency.
//
// Two things this read guarantees that the inline query it replaces did not:
//
//   1. A TOTAL order. Every payment's `paid_at` is midnight Pacific of the day
//      chosen in the form (parsePfaInput(date, "00:00")), so every payment
//      entered for one day has the IDENTICAL `paid_at`. Ordering by `paid_at`
//      alone left the order inside a day up to Postgres — and a row limit that
//      lands inside a day then shows an arbitrary subset that can change from
//      one load to the next. The three-key order below makes "the first N
//      rows" mean the same rows every time, which is what lets the list grow
//      without reshuffling what is already on screen.
//
//   2. A true count of everything the list could show, so the page can say
//      "100 of 243" instead of just stopping.
//
// No raw `sql` here on purpose: drizzle's column parsers and its `count()`
// helper keep the row and count reads on the same typed path.

import { count, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { coachPayments, users } from "@/db/schema";

type CoachPaymentRecord = typeof coachPayments.$inferSelect;

export type PaymentHistoryRow = {
  id: string;
  coachId: string;
  /** Nullable — the page falls back to the email. */
  coachName: string | null;
  coachEmail: string;
  amountCents: number;
  method: CoachPaymentRecord["method"];
  direction: CoachPaymentRecord["direction"];
  paidAt: Date;
  coversThrough: Date | null;
  reference: string | null;
  note: string | null;
  status: CoachPaymentRecord["status"];
  recordedAt: Date;
};

export type PaymentHistoryResult = {
  rows: PaymentHistoryRow[];
  /** Every non-deleted payment, regardless of `limit`. */
  count: number;
};

// "A payment the list can show": not soft-deleted. Pending rows count, exactly
// as they always have. Defined ONCE and used by both queries below — two
// hand-maintained filters drift, and then the caption disagrees with the rows.
const notDeleted = isNull(coachPayments.deletedAt);

/**
 * The newest `limit` payments plus the count of all of them.
 *
 * `limit` must already be normalized (see normalizeShown in history.ts) — this
 * function trusts it.
 */
export async function fetchPaymentHistory(
  limit: number,
): Promise<PaymentHistoryResult> {
  const [rows, countRows] = await Promise.all([
    db
      .select({
        id: coachPayments.id,
        coachId: coachPayments.coachId,
        coachName: users.name,
        coachEmail: users.email,
        amountCents: coachPayments.amountCents,
        method: coachPayments.method,
        direction: coachPayments.direction,
        paidAt: coachPayments.paidAt,
        // The period the money settles (nullable — "no period stated"). Shown
        // as its own column so July money that arrived in August reads as July.
        coversThrough: coachPayments.coversThrough,
        reference: coachPayments.reference,
        note: coachPayments.note,
        status: coachPayments.status,
        recordedAt: coachPayments.recordedAt,
      })
      .from(coachPayments)
      .innerJoin(users, eq(coachPayments.coachId, users.id))
      .where(notDeleted)
      // Newest paid day first; inside a day, most recently ENTERED first;
      // `id` breaks any remaining tie so the order is total.
      .orderBy(
        desc(coachPayments.paidAt),
        desc(coachPayments.recordedAt),
        desc(coachPayments.id),
      )
      .limit(limit),
    // No join needed: coach_id is a NOT NULL foreign key to users, so the
    // inner join above can never drop a payment and the two reads agree.
    db.select({ value: count() }).from(coachPayments).where(notDeleted),
  ]);

  return { rows, count: countRows[0]?.value ?? 0 };
}
