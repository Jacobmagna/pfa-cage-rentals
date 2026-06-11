import { describe, expect, it } from "vitest";
import { netCoachLedgers, type LedgerPayment } from "./payment-ledger";

describe("netCoachLedgers", () => {
  it("a coach_to_pfa payment reduces the cage balance ONLY", () => {
    const payments: LedgerPayment[] = [
      { amountCents: 5000, direction: "coach_to_pfa" },
    ];
    const l = netCoachLedgers(20000, 30000, payments);

    // Cage ledger nets the payment.
    expect(l.owedCageCents).toBe(20000);
    expect(l.paidCageCents).toBe(5000);
    expect(l.cageBalanceCents).toBe(15000);

    // Work ledger is untouched.
    expect(l.owedWorkCents).toBe(30000);
    expect(l.paidWorkCents).toBe(0);
    expect(l.workBalanceCents).toBe(30000);
  });

  it("a pfa_to_coach payment reduces the work balance ONLY", () => {
    const payments: LedgerPayment[] = [
      { amountCents: 8000, direction: "pfa_to_coach" },
    ];
    const l = netCoachLedgers(20000, 30000, payments);

    // Work ledger nets the payment.
    expect(l.owedWorkCents).toBe(30000);
    expect(l.paidWorkCents).toBe(8000);
    expect(l.workBalanceCents).toBe(22000);

    // Cage ledger is untouched.
    expect(l.owedCageCents).toBe(20000);
    expect(l.paidCageCents).toBe(0);
    expect(l.cageBalanceCents).toBe(20000);
  });

  it("routes a mix of both directions into their own ledgers without crossing", () => {
    const payments: LedgerPayment[] = [
      { amountCents: 5000, direction: "coach_to_pfa" },
      { amountCents: 2500, direction: "coach_to_pfa" },
      { amountCents: 8000, direction: "pfa_to_coach" },
    ];
    const l = netCoachLedgers(20000, 30000, payments);

    expect(l.paidCageCents).toBe(7500);
    expect(l.cageBalanceCents).toBe(12500);
    expect(l.paidWorkCents).toBe(8000);
    expect(l.workBalanceCents).toBe(22000);
  });

  it("with no payments, both balances equal their owed totals", () => {
    const l = netCoachLedgers(20000, 30000, []);
    expect(l.cageBalanceCents).toBe(20000);
    expect(l.workBalanceCents).toBe(30000);
  });

  it("overpayment drives a balance negative (PFA/coach is owed back)", () => {
    const payments: LedgerPayment[] = [
      { amountCents: 25000, direction: "coach_to_pfa" },
    ];
    const l = netCoachLedgers(20000, 0, payments);
    expect(l.cageBalanceCents).toBe(-5000);
  });
});
