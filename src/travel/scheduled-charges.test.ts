import { beforeAll, describe, expect, it } from "vitest";

// Pure-logic unit test for the scheduled-charge amount clamp — the runner itself
// is DB+network (the Orchestrator live-proves it), so only the pure money helper
// is unit-tested here. The clamp guarantees the autopay executor NEVER charges
// more than the live invoice balance.
//
// scheduled-charges.ts imports "@/db" at module load, and src/db/index.ts THROWS
// unless DATABASE_URL is set. The helper makes no DB call, so we set a dummy URL
// (never connected to) and dynamically import AFTER — mirrors the
// payments-installments.test.ts convention.
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

let clampChargeAmountCents: (
  chargeAmountCents: number,
  invoiceBalanceCents: number,
) => number;

beforeAll(async () => {
  ({ clampChargeAmountCents } = await import("./scheduled-charges"));
});

describe("clampChargeAmountCents", () => {
  it("returns the charge amount when it is <= the balance", () => {
    expect(clampChargeAmountCents(5000, 5000)).toBe(5000);
    expect(clampChargeAmountCents(3000, 5000)).toBe(3000);
  });

  it("clamps down to the balance when the charge exceeds it", () => {
    // Balance dropped (e.g. a partial manual payment) since the charge was scheduled.
    expect(clampChargeAmountCents(5000, 2000)).toBe(2000);
  });

  it("never returns more than is owed", () => {
    expect(clampChargeAmountCents(10_000, 0)).toBe(0);
  });
});
