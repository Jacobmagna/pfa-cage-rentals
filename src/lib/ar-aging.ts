// 1b security C — Overdue cage-balance / AR aging. Pure logic, NO db
// imports — every input is a plain value so this stays unit-test friendly
// and reusable from the loader. Mirrors src/lib/cancellation.ts style.
//
// Balance model (identical to /admin/payments): a coach's balance is the
// sum of what they OWE PFA for cage rentals (each rental's owed cents,
// from totalFromSnapshot) MINUS their confirmed, non-deleted payments.
// Program/work pay (a payout PFA owes the coach) is NOT part of this — it
// flows the other direction and never reduces the cage balance.
//
// Aging is DERIVED on read (FIFO oldest-unpaid) rather than stored, so the
// policy thresholds below can change without a data migration.

// Overdue if the unpaid balance is strictly greater than $350 …
export const OVERDUE_BALANCE_CENTS = 35_000;
// … OR the oldest unpaid rental is strictly more than 30 days old.
export const OVERDUE_AGE_DAYS = 30;

const DAY_MS = 86_400_000;

export type AgingRental = { startAt: Date; owedCents: number };

export type OverdueReason = "balance" | "age";

export type AgingResult = {
  balanceCents: number; // max(0, owed − paid)
  oldestUnpaidAt: Date | null; // FIFO: oldest rental not covered by payments
  oldestUnpaidDays: number; // whole days since oldestUnpaidAt (0 if none)
  overdue: boolean;
  reasons: OverdueReason[];
};

/**
 * Compute a coach's overdue/aging status from their cage rentals and their
 * confirmed-payment total.
 *
 * `balanceCents` = max(0, sum(rentals.owedCents) − paidCents). Overpayment
 * floors at 0 (PFA doesn't owe the coach a cage refund here).
 *
 * `oldestUnpaidAt` is found FIFO: rentals are sorted oldest-first and
 * `paidCents` is applied to each in turn. The first rental still carrying
 * owed cents after payments are exhausted is the oldest unpaid one. When
 * payments cover the whole receivable (`paidCents >= owed`), it's null.
 *
 * Deterministic and total over its inputs — no Date.now(), `now` is passed.
 */
export function computeAging(
  rentals: AgingRental[],
  paidCents: number,
  now: Date,
): AgingResult {
  const owed = rentals.reduce((sum, r) => sum + r.owedCents, 0);
  const balanceCents = Math.max(0, owed - paidCents);

  // FIFO walk: apply payments to rentals oldest-first; the first rental with
  // owed left over is the oldest unpaid. A non-positive-owed rental can never
  // be "unpaid", so it's skipped over naturally by the running tally.
  const sorted = [...rentals].sort(
    (a, b) => a.startAt.getTime() - b.startAt.getTime(),
  );
  let remainingPaid = paidCents;
  let oldestUnpaidAt: Date | null = null;
  for (const r of sorted) {
    if (r.owedCents <= 0) continue;
    if (remainingPaid >= r.owedCents) {
      remainingPaid -= r.owedCents;
      continue;
    }
    // This rental is only partially (or not at all) covered → oldest unpaid.
    oldestUnpaidAt = r.startAt;
    break;
  }

  const oldestUnpaidDays = oldestUnpaidAt
    ? Math.floor((now.getTime() - oldestUnpaidAt.getTime()) / DAY_MS)
    : 0;

  const reasons: OverdueReason[] = [];
  if (balanceCents > OVERDUE_BALANCE_CENTS) reasons.push("balance");
  // Age only matters when something is actually owed.
  if (balanceCents > 0 && oldestUnpaidDays > OVERDUE_AGE_DAYS) {
    reasons.push("age");
  }

  return {
    balanceCents,
    oldestUnpaidAt,
    oldestUnpaidDays,
    overdue: reasons.length > 0,
    reasons,
  };
}
