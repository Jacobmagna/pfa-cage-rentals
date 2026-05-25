// Pure aggregation: owed-vs-paid per coach. No DB — caller supplies
// session rows + override rows + payment rows, so the same module
// drives /admin/payments, /admin/coaches/[id], and the future
// /coach/payments view without duplicating SQL.
//
// "Owed" = sum of charges for every session whose coach is in the
// roster (no date filter — the balance is all-time outstanding).
// "Paid" = sum of confirmed coach_payments. Pending payments do NOT
// reduce the balance — they sit in the inbox until Dad confirms.
// Negative balances (over-paid) are possible and surfaced as-is so
// Dad can correct them.

import {
  chargeForSession,
  type RateOverride,
  type ResourceType,
} from "@/lib/billing";

export type BalanceSessionInput = {
  coachId: string;
  resourceType: ResourceType;
  startAt: Date;
  endAt: Date;
};

export type BalancePaymentInput = {
  coachId: string;
  amountCents: number;
};

export type CoachBalance = {
  coachId: string;
  owedCents: number;
  paidCents: number;
  balanceCents: number;
};

export function computeBalances(
  coachIds: string[],
  sessions: BalanceSessionInput[],
  overrides: RateOverride[],
  confirmedPayments: BalancePaymentInput[],
): Map<string, CoachBalance> {
  const owed = new Map<string, number>();
  for (const s of sessions) {
    const charge = chargeForSession(s, overrides);
    owed.set(s.coachId, (owed.get(s.coachId) ?? 0) + charge.totalCents);
  }

  const paid = new Map<string, number>();
  for (const p of confirmedPayments) {
    paid.set(p.coachId, (paid.get(p.coachId) ?? 0) + p.amountCents);
  }

  const out = new Map<string, CoachBalance>();
  for (const coachId of coachIds) {
    const o = owed.get(coachId) ?? 0;
    const p = paid.get(coachId) ?? 0;
    out.set(coachId, {
      coachId,
      owedCents: o,
      paidCents: p,
      balanceCents: o - p,
    });
  }
  // Also include coaches who appear in sessions/payments but aren't in
  // the active roster (e.g. since-deleted coaches with historical rows)
  // so their balance doesn't silently disappear from totals.
  for (const coachId of owed.keys()) {
    if (out.has(coachId)) continue;
    const o = owed.get(coachId) ?? 0;
    const p = paid.get(coachId) ?? 0;
    out.set(coachId, {
      coachId,
      owedCents: o,
      paidCents: p,
      balanceCents: o - p,
    });
  }
  for (const coachId of paid.keys()) {
    if (out.has(coachId)) continue;
    out.set(coachId, {
      coachId,
      owedCents: 0,
      paidCents: paid.get(coachId) ?? 0,
      balanceCents: -(paid.get(coachId) ?? 0),
    });
  }
  return out;
}
