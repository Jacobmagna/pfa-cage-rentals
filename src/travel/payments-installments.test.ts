import { beforeAll, describe, expect, it } from "vitest";

// Pure-module unit tests for the installment status helper (no DB I/O). Mirrors
// the pricing.test.ts convention. This is the ONLY new pure logic in Block
// 4b-2-b-1; the DB-touching webhook applier is live-proven by the Orchestrator.
//
// nextInstallmentStatus lives in payments.ts, which imports "@/db" at module
// load — and src/db/index.ts THROWS unless DATABASE_URL is set. The helper makes
// no DB call, so we set a dummy URL (never connected to) and dynamically import
// AFTER, so importing the module can't crash on the env guard.
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

let nextInstallmentStatus: (
  paidAfterCents: number,
  amountCents: number,
) => "scheduled" | "partial" | "paid";

beforeAll(async () => {
  ({ nextInstallmentStatus } = await import("./payments"));
});

describe("nextInstallmentStatus", () => {
  it("is 'paid' when the paid-so-far meets the amount exactly", () => {
    expect(nextInstallmentStatus(10000, 10000)).toBe("paid");
  });

  it("is 'paid' when the paid-so-far exceeds the amount (over-clamp safety)", () => {
    expect(nextInstallmentStatus(12000, 10000)).toBe("paid");
  });

  it("is 'partial' when 0 < paid < amount", () => {
    expect(nextInstallmentStatus(1, 10000)).toBe("partial");
    expect(nextInstallmentStatus(9999, 10000)).toBe("partial");
  });

  it("is 'scheduled' when nothing has been paid yet", () => {
    expect(nextInstallmentStatus(0, 10000)).toBe("scheduled");
  });

  it("is 'paid' for a zero-amount installment (0 >= 0)", () => {
    expect(nextInstallmentStatus(0, 0)).toBe("paid");
  });

  it("throws on a negative paid-so-far", () => {
    expect(() => nextInstallmentStatus(-1, 10000)).toThrow();
  });

  it("throws on a negative amount", () => {
    expect(() => nextInstallmentStatus(100, -1)).toThrow();
  });
});
