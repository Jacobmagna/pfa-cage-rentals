import { describe, expect, it } from "vitest";
import {
  computeInvoiceLines,
  resolveTierPrice,
  type PriceTier,
  type PricingAdjustment,
} from "./pricing";

// Pure-module unit tests for the travel pricing engine (no DB). Mirrors the
// house pure-logic test convention (billing.test.ts). Registration only ever
// calls computeInvoiceLines with an EMPTY adjustments list today, but the
// engine's full branch space is exercised so the ported math is provably
// unchanged from Northstar.

describe("computeInvoiceLines", () => {
  it("emits a single base line for a flat product with no adjustments", () => {
    const { lines, totalCents } = computeInvoiceLines({
      basePriceCents: 150000,
      baseDescription: "16U Travel — Season Dues",
      adjustments: [],
    });
    expect(lines).toEqual([
      { description: "16U Travel — Season Dues", amountCents: 150000 },
    ]);
    expect(totalCents).toBe(150000);
  });

  it("defaults the base description when none is given", () => {
    const { lines } = computeInvoiceLines({ basePriceCents: 5000, adjustments: [] });
    expect(lines[0].description).toBe("Base price");
  });

  it("stacks add-ons (positive) then flat then percent reductions in order", () => {
    const adjustments: PricingAdjustment[] = [
      { type: "financial_aid", method: "percent", percent: 10, name: "Aid 10%" },
      { type: "add_on", method: "flat", amountCents: 600_00, name: "Uniform add-on" },
      { type: "family_sibling", method: "flat", amountCents: 100_00, name: "Sibling" },
    ];
    const { lines, totalCents } = computeInvoiceLines({
      basePriceCents: 1000_00,
      baseDescription: "Base",
      adjustments,
    });
    // base 100000 + add-on 60000 = 160000; − flat 10000 = 150000;
    // − 10% of 150000 (15000) = 135000.
    expect(lines.map((l) => l.amountCents)).toEqual([
      100000, 60000, -10000, -15000,
    ]);
    expect(lines.reduce((n, l) => n + l.amountCents, 0)).toBe(totalCents);
    expect(totalCents).toBe(135000);
  });

  it("clamps an over-discounted total at 0", () => {
    const { totalCents } = computeInvoiceLines({
      basePriceCents: 10000,
      adjustments: [
        { type: "custom", method: "flat", amountCents: 99999, name: "Comp" },
      ],
    });
    expect(totalCents).toBe(0);
  });

  it("rounds a percent reduction half-up on the cents", () => {
    // 1% of 12345 = 123.45 → rounds to 123.
    const { lines } = computeInvoiceLines({
      basePriceCents: 12345,
      adjustments: [
        { type: "financial_aid", method: "percent", percent: 1, name: "1%" },
      ],
    });
    expect(lines[1].amountCents).toBe(-123);
  });

  it("throws on a non-integer or negative base price", () => {
    expect(() => computeInvoiceLines({ basePriceCents: 1.5, adjustments: [] })).toThrow();
    expect(() => computeInvoiceLines({ basePriceCents: -1, adjustments: [] })).toThrow();
  });

  it("throws on a malformed flat adjustment", () => {
    expect(() =>
      computeInvoiceLines({
        basePriceCents: 100,
        adjustments: [{ type: "custom", method: "flat", name: "bad" }],
      }),
    ).toThrow();
  });

  it("throws on a malformed percent adjustment", () => {
    expect(() =>
      computeInvoiceLines({
        basePriceCents: 100,
        adjustments: [{ type: "custom", method: "percent", name: "bad" }],
      }),
    ).toThrow();
  });
});

describe("resolveTierPrice", () => {
  const tiers: PriceTier[] = [
    { key: "full", label: "Full Season", priceCents: 200000 },
    { key: "half", label: "Half Season", priceCents: 120000 },
  ];

  it("returns tier_required when the product has no tiers", () => {
    expect(resolveTierPrice(null, "full")).toEqual({
      ok: false,
      error: "tier_required",
    });
    expect(resolveTierPrice([], "full")).toEqual({
      ok: false,
      error: "tier_required",
    });
  });

  it("returns tier_required when tiers exist but no/blank key is sent", () => {
    expect(resolveTierPrice(tiers, null)).toEqual({
      ok: false,
      error: "tier_required",
    });
    expect(resolveTierPrice(tiers, "   ")).toEqual({
      ok: false,
      error: "tier_required",
    });
  });

  it("returns tier_not_found for an unknown key", () => {
    expect(resolveTierPrice(tiers, "nope")).toEqual({
      ok: false,
      error: "tier_not_found",
    });
  });

  it("resolves the matching tier by key (server-side price, never client)", () => {
    const res = resolveTierPrice(tiers, "half");
    expect(res).toEqual({ ok: true, tier: tiers[1] });
  });
});
