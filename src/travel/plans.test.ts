import { beforeAll, describe, expect, it } from "vitest";

// Pure-module unit tests for the monthly-plan splitter + month helper (no DB I/O).
// Mirrors the pricing.test.ts / payments-installments.test.ts convention.
//
// computeMonthlyInstallments/addMonths live in plans.ts, which imports "@/db" at
// module load — and src/db/index.ts THROWS unless DATABASE_URL is set. These
// helpers make no DB call, so we set a dummy URL (never connected to) and
// dynamically import AFTER, so importing the module can't crash on the env guard.
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

let addMonths: (date: Date, n: number) => Date;
let addOneMonth: (date: Date) => Date;
let computeMonthlyInstallments: (
  balanceCents: number,
  monthlyCents: number,
  startDate: Date,
) => { seq: number; dueDate: Date; amountCents: number }[];

beforeAll(async () => {
  ({ addMonths, addOneMonth, computeMonthlyInstallments } = await import(
    "./plans"
  ));
});

describe("addMonths", () => {
  it("adds whole months preserving the day-of-month", () => {
    expect(addMonths(new Date("2026-01-15T00:00:00Z"), 1)).toEqual(
      new Date("2026-02-15T00:00:00Z"),
    );
  });

  it("clamps day-of-month overflow (Jan 31 + 1mo → Feb 28 in a non-leap year)", () => {
    // 2026 is not a leap year → Feb has 28 days.
    const d = new Date(2026, 0, 31); // Jan 31 2026 (local)
    const r = addMonths(d, 1);
    expect(r.getFullYear()).toBe(2026);
    expect(r.getMonth()).toBe(1); // February
    expect(r.getDate()).toBe(28);
  });

  it("clamps into a leap February (Jan 31 2028 + 1mo → Feb 29)", () => {
    const d = new Date(2028, 0, 31);
    const r = addMonths(d, 1);
    expect(r.getMonth()).toBe(1);
    expect(r.getDate()).toBe(29);
  });

  it("rolls the year over across December", () => {
    const d = new Date(2026, 10, 15); // Nov 15 2026
    const r = addMonths(d, 2); // → Jan 15 2027
    expect(r.getFullYear()).toBe(2027);
    expect(r.getMonth()).toBe(0);
    expect(r.getDate()).toBe(15);
  });

  it("preserves the time-of-day", () => {
    const d = new Date(2026, 2, 10, 9, 30, 0);
    const r = addMonths(d, 1);
    expect(r.getHours()).toBe(9);
    expect(r.getMinutes()).toBe(30);
  });

  it("addOneMonth === addMonths(d, 1)", () => {
    const d = new Date(2026, 5, 1);
    expect(addOneMonth(d)).toEqual(addMonths(d, 1));
  });
});

describe("computeMonthlyInstallments", () => {
  const start = new Date(2026, 0, 1); // Jan 1 2026

  it("splits evenly when the monthly divides the balance (last is a full monthly)", () => {
    const r = computeMonthlyInstallments(125000, 25000, start);
    expect(r.map((i) => i.amountCents)).toEqual([
      25000, 25000, 25000, 25000, 25000,
    ]);
    expect(r.map((i) => i.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(r.reduce((n, i) => n + i.amountCents, 0)).toBe(125000);
  });

  it("puts the remainder in a final tail installment", () => {
    const r = computeMonthlyInstallments(130000, 25000, start);
    expect(r.map((i) => i.amountCents)).toEqual([
      25000, 25000, 25000, 25000, 25000, 5000,
    ]);
    expect(r).toHaveLength(6);
    expect(r.reduce((n, i) => n + i.amountCents, 0)).toBe(130000);
  });

  it("returns a single installment for balance < monthly (= the whole balance)", () => {
    const r = computeMonthlyInstallments(10000, 25000, start);
    expect(r).toHaveLength(1);
    expect(r[0].amountCents).toBe(10000);
    expect(r[0].seq).toBe(1);
  });

  it("returns a single full installment when balance === monthly", () => {
    const r = computeMonthlyInstallments(25000, 25000, start);
    expect(r).toHaveLength(1);
    expect(r[0].amountCents).toBe(25000);
  });

  it("spaces due dates one calendar month apart from startDate", () => {
    const r = computeMonthlyInstallments(75000, 25000, start);
    expect(r[0].dueDate).toEqual(new Date(2026, 0, 1));
    expect(r[1].dueDate).toEqual(new Date(2026, 1, 1));
    expect(r[2].dueDate).toEqual(new Date(2026, 2, 1));
  });

  it("carries month-rollover due dates through the remainder tail", () => {
    // 6 installments from Nov 1 2026 → Nov, Dec 2026, Jan..Apr 2027.
    const nov = new Date(2026, 10, 1);
    const r = computeMonthlyInstallments(130000, 25000, nov);
    expect(r[5].dueDate).toEqual(new Date(2027, 3, 1)); // Apr 1 2027
  });

  it("throws on a non-positive balance", () => {
    expect(() => computeMonthlyInstallments(0, 25000, start)).toThrow();
    expect(() => computeMonthlyInstallments(-1, 25000, start)).toThrow();
  });

  it("throws on a non-positive monthly amount", () => {
    expect(() => computeMonthlyInstallments(125000, 0, start)).toThrow();
    expect(() => computeMonthlyInstallments(125000, -1, start)).toThrow();
  });

  it("throws on non-integer cents", () => {
    expect(() => computeMonthlyInstallments(125000.5, 25000, start)).toThrow();
    expect(() => computeMonthlyInstallments(125000, 25000.5, start)).toThrow();
  });
});
