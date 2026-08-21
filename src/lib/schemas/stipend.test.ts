// stipend SPEC §6.2/§6.3 — the stipend BOUNDARY schemas and the dollars→cents
// parser the admin card posts through.
//
// 🔴 THE PARSER IS THE POINT OF THIS FILE. Every stipend amount Mark ever
// types passes through `dollarsToCents`.
//
// ⚠️ BE PRECISE ABOUT THE HAZARD — an earlier draft of this file was not, and
// a mutation caught it. `parseFloat("19.99") * 100` really is
// `1998.9999999999998`, but `Math.round(...)` of that IS 1999, so a rounded
// float implementation is genuinely equivalent here and swapping it in breaks
// nothing. The version that breaks is the UNROUNDED one: it returns a
// fractional "cents" value, which `amountCents.int()` then rejects — so a
// perfectly valid $19.99 comes back to the admin as "must be a whole number
// of cents". The invariant worth pinning is therefore not "which arithmetic"
// but "the result is always an integer".

import { describe, expect, it } from "vitest";
import {
  dollarsToCents,
  endCoachStipendSchema,
  setCoachStipendSchema,
} from "./stipend";

describe("dollarsToCents", () => {
  it("parses whole dollars", () => {
    expect(dollarsToCents("2500")).toBe(250_000);
    expect(dollarsToCents("0")).toBe(0);
    expect(dollarsToCents("1")).toBe(100);
  });

  it("parses one and two decimal places", () => {
    expect(dollarsToCents("2500.00")).toBe(250_000);
    expect(dollarsToCents("2500.5")).toBe(250_050);
    expect(dollarsToCents("2500.50")).toBe(250_050);
    expect(dollarsToCents("0.01")).toBe(1);
    expect(dollarsToCents("0.1")).toBe(10);
  });

  it("🔴 does not drift on the amounts float arithmetic gets wrong", () => {
    // Each of these is a value where `parseFloat(v) * 100` does NOT land on a
    // whole number. If this test ever fails, someone "simplified" the parser.
    expect(dollarsToCents("19.99")).toBe(1_999);
    expect(dollarsToCents("2500.10")).toBe(250_010);
    expect(dollarsToCents("1.10")).toBe(110);
    expect(dollarsToCents("8.20")).toBe(820);
    expect(dollarsToCents("1145.10")).toBe(114_510);

    // ⚠️ NOT every amount drifts — `2500.10 * 100` lands on a clean 250010,
    // while `19.99`, `1.10`, `8.20` and `1145.10` do not. That asymmetry is
    // the hazard: an implementation that forgets to round is correct on most
    // inputs and silently wrong on the rest, so "it worked when I tried it"
    // proves nothing.
    expect(Number.isInteger(parseFloat("19.99") * 100)).toBe(false);
    expect(Number.isInteger(parseFloat("1.10") * 100)).toBe(false);
    expect(Number.isInteger(parseFloat("8.20") * 100)).toBe(false);
    expect(Number.isInteger(parseFloat("1145.10") * 100)).toBe(false);
    expect(Number.isInteger(parseFloat("2500.10") * 100)).toBe(true); // ← lands clean
  });

  it("🔴 always returns a WHOLE number of cents", () => {
    // THE assertion that separates a correct parser from a broken one. A
    // fractional result is rejected downstream by `amountCents.int()`, so an
    // unrounded implementation turns a valid $19.99 into "must be a whole
    // number of cents" in front of the admin. Every drifting value above,
    // plus a sweep across all 100 cent-values at a magnitude that drifts.
    for (const v of ["19.99", "1.10", "8.20", "1145.10", "2500.10"]) {
      const cents = dollarsToCents(v);
      expect(cents, v).not.toBeNull();
      expect(Number.isInteger(cents!), `${v} → ${cents}`).toBe(true);
    }
    for (let c = 0; c < 100; c += 1) {
      const v = `1145.${String(c).padStart(2, "0")}`;
      const cents = dollarsToCents(v);
      expect(Number.isInteger(cents!), `${v} → ${cents}`).toBe(true);
      expect(cents).toBe(114_500 + c);
    }
  });

  it("tolerates the ways a person actually types money", () => {
    expect(dollarsToCents("$2500")).toBe(250_000);
    expect(dollarsToCents("  2500  ")).toBe(250_000);
    expect(dollarsToCents("2,500")).toBe(250_000);
    expect(dollarsToCents("$2,500.00")).toBe(250_000);
  });

  it("returns null rather than guessing at anything else", () => {
    for (const bad of [
      "",
      " ",
      "abc",
      "2500.123", // three decimals — a typo, not an amount
      "-2500", // negative is refused upstream too, but never parsed here
      "2500.", // trailing point
      ".50", // no whole part
      "2500 dollars",
      "2e3", // exponent notation is not money
      "NaN",
      "Infinity",
    ]) {
      expect(dollarsToCents(bad), `expected null for ${JSON.stringify(bad)}`).toBeNull();
    }
  });
});

describe("setCoachStipendSchema", () => {
  const base = {
    coachId: "coach-1",
    amountCents: 250_000,
    effectiveFrom: new Date("2026-09-01T07:00:00.000Z"),
  };

  it("accepts a well-formed payload", () => {
    expect(() => setCoachStipendSchema.parse(base)).not.toThrow();
  });

  it("🔴 refuses $0 — the schema states the rule as well as the planner", () => {
    // Both layers on purpose: the schema is the boundary the form hits, the
    // planner is the boundary EVERY caller hits, including a future one that
    // never sees this schema.
    expect(() =>
      setCoachStipendSchema.parse({ ...base, amountCents: 0 }),
    ).toThrow(/greater than \$0/i);
  });

  it("refuses a negative amount and fractional cents", () => {
    expect(() =>
      setCoachStipendSchema.parse({ ...base, amountCents: -1 }),
    ).toThrow();
    expect(() =>
      setCoachStipendSchema.parse({ ...base, amountCents: 1.5 }),
    ).toThrow(/whole number/i);
  });

  it("caps a fat-fingered amount at $10,000", () => {
    expect(() =>
      setCoachStipendSchema.parse({ ...base, amountCents: 1_000_001 }),
    ).toThrow(/10,000/);
    expect(() =>
      setCoachStipendSchema.parse({ ...base, amountCents: 1_000_000 }),
    ).not.toThrow();
  });

  it("coerces a date string, because a form posts strings", () => {
    const parsed = setCoachStipendSchema.parse({
      ...base,
      effectiveFrom: "2026-09-01T07:00:00.000Z",
    });
    expect(parsed.effectiveFrom.getTime()).toBe(base.effectiveFrom.getTime());
  });

  it("strips confirmBackdate from nothing — it is a command flag, not data", () => {
    const parsed = setCoachStipendSchema.parse({
      ...base,
      confirmBackdate: true,
    });
    // It survives parsing (the action reads it) but it is deliberately NOT a
    // column — nothing writes it anywhere.
    expect(parsed.confirmBackdate).toBe(true);
    expect("amountCents" in parsed).toBe(true);
  });

  it("requires a coachId", () => {
    expect(() => setCoachStipendSchema.parse({ ...base, coachId: "" })).toThrow();
  });
});

describe("endCoachStipendSchema", () => {
  it("accepts a coachId and a date", () => {
    expect(() =>
      endCoachStipendSchema.parse({
        coachId: "coach-1",
        effectiveTo: new Date("2026-10-01T07:00:00.000Z"),
      }),
    ).not.toThrow();
  });

  it("requires both", () => {
    expect(() => endCoachStipendSchema.parse({ coachId: "coach-1" })).toThrow();
    expect(() =>
      endCoachStipendSchema.parse({ effectiveTo: new Date() }),
    ).toThrow();
  });
});
