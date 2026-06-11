// QA2 #9 — two-ledger payment netting. PFA and each coach owe each other in
// OPPOSITE directions and the two debts are NEVER netted against one another:
//
//   - Cage-rental ledger: the coach OWES PFA for cage rentals. Confirmed
//     payments with direction "coach_to_pfa" pay this down.
//       cageBalance = owedCage − paidCageToPfa
//
//   - Work ledger: PFA OWES the coach for posted work (program) hours.
//     Confirmed payments with direction "pfa_to_coach" pay this down.
//       workBalance = owedWork − paidPfaToCoach
//
// Only CONFIRMED, non-deleted payments reduce a balance — pending entries
// (either direction) are tracked separately and never move a balance (the
// existing inbox rule). The caller is responsible for passing only confirmed,
// non-deleted rows in `payments`; this helper just routes by direction.
//
// Pure + dependency-free so the netting math is unit-testable in isolation.

import type { PaymentDirection } from "@/lib/schemas/payment";

export type LedgerPayment = {
  amountCents: number;
  direction: PaymentDirection;
};

export type CoachLedgers = {
  /** Cage rentals: coach owes PFA. */
  owedCageCents: number;
  /** Confirmed coach→PFA payments applied to the cage ledger. */
  paidCageCents: number;
  /** owedCage − paidCage (positive = coach still owes PFA). */
  cageBalanceCents: number;
  /** Work hours: PFA owes coach. */
  owedWorkCents: number;
  /** Confirmed PFA→coach payments applied to the work ledger. */
  paidWorkCents: number;
  /** owedWork − paidWork (positive = PFA still owes the coach). */
  workBalanceCents: number;
};

/**
 * Net a single coach's two ledgers from their lifetime owed totals and a list
 * of CONFIRMED, non-deleted payments. Payments are split by direction:
 * coach_to_pfa reduces the cage balance only; pfa_to_coach reduces the work
 * balance only. The two never cross.
 */
export function netCoachLedgers(
  owedCageCents: number,
  owedWorkCents: number,
  payments: readonly LedgerPayment[],
): CoachLedgers {
  let paidCageCents = 0;
  let paidWorkCents = 0;
  for (const p of payments) {
    if (p.direction === "pfa_to_coach") {
      paidWorkCents += p.amountCents;
    } else {
      // Default / coach_to_pfa → cage ledger.
      paidCageCents += p.amountCents;
    }
  }
  return {
    owedCageCents,
    paidCageCents,
    cageBalanceCents: owedCageCents - paidCageCents,
    owedWorkCents,
    paidWorkCents,
    workBalanceCents: owedWorkCents - paidWorkCents,
  };
}
