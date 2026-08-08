// Unit matrix for the shared dollars → cents parsers (Phase D2).
//
// The reason this file exists at all: Phase D2 made the CLIENT convert the
// same typed string the SERVER converts, so the inline preview can quote the
// not-yet-saved rate. If the two ever disagreed, the preview would show one
// number and the save would write another — on a payroll surface, for an owner
// who has already been burned once by a misread rate model.
//
// The halving asymmetry is the headline case: hourly is typed per hour and
// stored per 30 min (HALVED); per-session is a flat fee (NEVER halved). That
// is the shipped bug class from migration 0052 and it is asserted directly.

import { describe, expect, it } from "vitest";
import {
  dollarsToCents,
  hourlyDollarsToCentsPer30Min,
  optionalHourlyDollarsToCentsPer30Min,
  optionalSessionDollarsToCents,
  tryFlatDollarsToCents,
  tryHourlyDollarsToCentsPer30Min,
  tryOptionalHourlyDollarsToCentsPer30Min,
} from "./rate-input";

describe("dollarsToCents (required, already in storage unit)", () => {
  it("parses whole and decimal dollars", () => {
    expect(dollarsToCents("22")).toBe(2200);
    expect(dollarsToCents("22.5")).toBe(2250);
    expect(dollarsToCents("22.50")).toBe(2250);
  });

  it("accepts a leading $ and surrounding whitespace", () => {
    expect(dollarsToCents("  $22.50 ")).toBe(2250);
  });

  it("rejects blank, non-numeric, negative, zero and >2dp", () => {
    expect(() => dollarsToCents("")).toThrow("Rate is required");
    expect(() => dollarsToCents("abc")).toThrow("positive dollar amount");
    expect(() => dollarsToCents("-5")).toThrow("positive dollar amount");
    expect(() => dollarsToCents("22.505")).toThrow("positive dollar amount");
    expect(() => dollarsToCents("0")).toThrow("greater than $0");
  });
});

describe("hourlyDollarsToCentsPer30Min (required, HALVED)", () => {
  it("halves per-hour dollars into per-30-min cents", () => {
    expect(hourlyDollarsToCentsPer30Min("44")).toBe(2200);
    expect(hourlyDollarsToCentsPer30Min("60")).toBe(3000);
    expect(hourlyDollarsToCentsPer30Min("44.50")).toBe(2225);
  });

  it("rounds odd half-cents deterministically (multiply before divide)", () => {
    // $44.51/hr = 4451 cents/hr = 2225.5 per 30 min → 2226.
    expect(hourlyDollarsToCentsPer30Min("44.51")).toBe(2226);
  });

  it("rejects blank, zero and malformed input", () => {
    expect(() => hourlyDollarsToCentsPer30Min("")).toThrow("Rate is required");
    expect(() => hourlyDollarsToCentsPer30Min("0")).toThrow("greater than $0");
    expect(() => hourlyDollarsToCentsPer30Min("4.4.4")).toThrow(
      "positive dollar amount",
    );
  });
});

describe("optionalHourlyDollarsToCentsPer30Min (program default, HALVED)", () => {
  it("treats blank as 'no rate set'", () => {
    expect(optionalHourlyDollarsToCentsPer30Min("")).toBeNull();
    expect(optionalHourlyDollarsToCentsPer30Min("   ")).toBeNull();
  });

  it("halves, and unlike the required parser allows an explicit 0", () => {
    expect(optionalHourlyDollarsToCentsPer30Min("44.00")).toBe(2200);
    expect(optionalHourlyDollarsToCentsPer30Min("0")).toBe(0);
  });

  it("rejects malformed input with the program-form wording", () => {
    expect(() => optionalHourlyDollarsToCentsPer30Min("lots")).toThrow(
      "Pay rate must be a positive dollar amount",
    );
  });
});

describe("optionalSessionDollarsToCents (FLAT — never halved)", () => {
  it("stores the amount as typed", () => {
    expect(optionalSessionDollarsToCents("100")).toBe(10000);
    expect(optionalSessionDollarsToCents("100.50")).toBe(10050);
  });

  it("treats blank as unset", () => {
    expect(optionalSessionDollarsToCents("")).toBeNull();
  });

  it("rejects malformed input with the per-session wording", () => {
    expect(() => optionalSessionDollarsToCents("$$5")).toThrow(
      "Per-session amount must be a positive dollar amount",
    );
  });
});

describe("the 0052 asymmetry — hourly halves, per-session does not", () => {
  it("prices the SAME typed string differently by mode, on purpose", () => {
    expect(hourlyDollarsToCentsPer30Min("100")).toBe(5000);
    expect(optionalSessionDollarsToCents("100")).toBe(10000);
    expect(dollarsToCents("100")).toBe(10000);
  });
});

describe("soft parsers (live preview only)", () => {
  it("return null instead of throwing on half-typed input", () => {
    expect(tryHourlyDollarsToCentsPer30Min("4.")).toBeNull();
    expect(tryHourlyDollarsToCentsPer30Min("")).toBeNull();
    expect(tryFlatDollarsToCents("")).toBeNull();
    expect(tryOptionalHourlyDollarsToCentsPer30Min("nope")).toBeNull();
  });

  it("agree exactly with the strict parser whenever it succeeds", () => {
    for (const input of ["44", "44.50", "1", "999.99"]) {
      expect(tryHourlyDollarsToCentsPer30Min(input)).toBe(
        hourlyDollarsToCentsPer30Min(input),
      );
      expect(tryFlatDollarsToCents(input)).toBe(dollarsToCents(input));
    }
  });

  it("passes a blank through as null for the OPTIONAL soft variant", () => {
    expect(tryOptionalHourlyDollarsToCentsPer30Min("")).toBeNull();
    expect(tryOptionalHourlyDollarsToCentsPer30Min("0")).toBe(0);
  });
});
