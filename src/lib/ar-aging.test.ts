import { describe, it, expect } from "vitest";
import {
  OVERDUE_AGE_DAYS,
  OVERDUE_BALANCE_CENTS,
  computeAging,
  type AgingRental,
} from "./ar-aging";

// Fixed reference instant (UTC). All rental ages are measured back from here.
const NOW = new Date("2026-06-01T12:00:00Z");

// Helper: a rental that started `days` whole days before NOW.
function daysAgo(days: number, owedCents: number): AgingRental {
  return {
    startAt: new Date(NOW.getTime() - days * 86_400_000),
    owedCents,
  };
}

describe("computeAging — balance boundary", () => {
  it("balance == 35000 is NOT over (strictly greater)", () => {
    const r = computeAging([daysAgo(1, OVERDUE_BALANCE_CENTS)], 0, NOW);
    expect(r.balanceCents).toBe(35_000);
    expect(r.reasons).not.toContain("balance");
    expect(r.overdue).toBe(false);
  });

  it("balance == 35001 is over via balance", () => {
    const r = computeAging([daysAgo(1, OVERDUE_BALANCE_CENTS + 1)], 0, NOW);
    expect(r.balanceCents).toBe(35_001);
    expect(r.reasons).toContain("balance");
    expect(r.overdue).toBe(true);
  });
});

describe("computeAging — age boundary", () => {
  it("exactly 30 days old is NOT over (strictly greater)", () => {
    const r = computeAging([daysAgo(OVERDUE_AGE_DAYS, 5_000)], 0, NOW);
    expect(r.oldestUnpaidDays).toBe(30);
    expect(r.reasons).not.toContain("age");
    expect(r.overdue).toBe(false);
  });

  it("31 days old is over via age", () => {
    const r = computeAging([daysAgo(OVERDUE_AGE_DAYS + 1, 5_000)], 0, NOW);
    expect(r.oldestUnpaidDays).toBe(31);
    expect(r.reasons).toContain("age");
    expect(r.overdue).toBe(true);
  });

  it("age never fires when balance is 0 even with an ancient rental", () => {
    // Old rental, but fully paid off → balance 0, no age flag.
    const r = computeAging([daysAgo(100, 5_000)], 5_000, NOW);
    expect(r.balanceCents).toBe(0);
    expect(r.oldestUnpaidAt).toBeNull();
    expect(r.reasons).toEqual([]);
    expect(r.overdue).toBe(false);
  });
});

describe("computeAging — FIFO oldest-unpaid", () => {
  it("payment covering the 2 oldest of 3 → oldest unpaid is the 3rd", () => {
    const r1 = daysAgo(40, 10_000);
    const r2 = daysAgo(25, 10_000);
    const r3 = daysAgo(10, 10_000);
    // Pay exactly the first two (20000); the 3rd (10 days old) is unpaid.
    const r = computeAging([r1, r2, r3], 20_000, NOW);
    expect(r.balanceCents).toBe(10_000);
    expect(r.oldestUnpaidAt).toEqual(r3.startAt);
    expect(r.oldestUnpaidDays).toBe(10);
    // 10 days < 30 and balance 10000 < 35000 → not overdue.
    expect(r.overdue).toBe(false);
  });

  it("partial payment leaves the partially-covered rental as oldest unpaid", () => {
    const r1 = daysAgo(40, 10_000);
    const r2 = daysAgo(25, 10_000);
    // Pay 5000 — r1 still has owed left → r1 is oldest unpaid.
    const r = computeAging([r1, r2], 5_000, NOW);
    expect(r.balanceCents).toBe(15_000);
    expect(r.oldestUnpaidAt).toEqual(r1.startAt);
    expect(r.oldestUnpaidDays).toBe(40);
    expect(r.reasons).toContain("age"); // 40 > 30
  });

  it("input order does not matter (sorts oldest-first)", () => {
    const r1 = daysAgo(40, 10_000);
    const r2 = daysAgo(25, 10_000);
    const r3 = daysAgo(10, 10_000);
    const r = computeAging([r3, r1, r2], 20_000, NOW);
    expect(r.oldestUnpaidAt).toEqual(r3.startAt);
  });
});

describe("computeAging — paid / overpaid edge cases", () => {
  it("fully paid → not overdue, oldestUnpaidAt null", () => {
    const r = computeAging(
      [daysAgo(40, 10_000), daysAgo(10, 10_000)],
      20_000,
      NOW,
    );
    expect(r.balanceCents).toBe(0);
    expect(r.oldestUnpaidAt).toBeNull();
    expect(r.oldestUnpaidDays).toBe(0);
    expect(r.overdue).toBe(false);
  });

  it("overpaid (paid > owed) → balance floors at 0, not overdue", () => {
    const r = computeAging([daysAgo(40, 10_000)], 15_000, NOW);
    expect(r.balanceCents).toBe(0);
    expect(r.oldestUnpaidAt).toBeNull();
    expect(r.overdue).toBe(false);
  });

  it("zero rentals → not overdue", () => {
    const r = computeAging([], 0, NOW);
    expect(r.balanceCents).toBe(0);
    expect(r.oldestUnpaidAt).toBeNull();
    expect(r.oldestUnpaidDays).toBe(0);
    expect(r.reasons).toEqual([]);
    expect(r.overdue).toBe(false);
  });
});

describe("computeAging — policy combinations", () => {
  it("small-but-old balance ($20, 40 days) → overdue via age only", () => {
    const r = computeAging([daysAgo(40, 2_000)], 0, NOW);
    expect(r.balanceCents).toBe(2_000);
    expect(r.reasons).toEqual(["age"]);
    expect(r.overdue).toBe(true);
  });

  it("big-but-recent balance ($500, 5 days) → overdue via balance only", () => {
    const r = computeAging([daysAgo(5, 50_000)], 0, NOW);
    expect(r.balanceCents).toBe(50_000);
    expect(r.reasons).toEqual(["balance"]);
    expect(r.overdue).toBe(true);
  });

  it("big AND old → both reasons", () => {
    const r = computeAging([daysAgo(45, 50_000)], 0, NOW);
    expect(r.reasons).toEqual(["balance", "age"]);
    expect(r.overdue).toBe(true);
  });
});
