import { describe, expect, it } from "vitest";
import { DISPLAY_TOKEN_MIN_LENGTH, isDisplayTokenValid } from "./token";

// A 32-char stand-in for a real token.
const GOOD = "a".repeat(16) + "b".repeat(16);

describe("isDisplayTokenValid — the happy path", () => {
  it("accepts an exact match", () => {
    expect(isDisplayTokenValid(GOOD, GOOD)).toBe(true);
  });

  it("accepts a token exactly at the minimum length", () => {
    const min = "x".repeat(DISPLAY_TOKEN_MIN_LENGTH);
    expect(isDisplayTokenValid(min, min)).toBe(true);
  });
});

describe("isDisplayTokenValid — fails closed on the OPERATOR's mistakes", () => {
  // 🔴 This block is the reason the module exists. The dangerous failure is
  // not a clever attacker, it is a misconfigured environment variable that
  // makes the route answer 200 to the whole internet.
  it("refuses when no token is configured at all", () => {
    expect(isDisplayTokenValid(GOOD, undefined)).toBe(false);
  });

  it("refuses when the configured token is an empty string", () => {
    // `DISPLAY_TOKEN=` in a dashboard is the single likeliest way to get
    // this wrong, and it LOOKS set.
    expect(isDisplayTokenValid("", "")).toBe(false);
  });

  it("refuses a configured token that is too short to be real", () => {
    const weak = "changeme";
    expect(weak.length).toBeLessThan(DISPLAY_TOKEN_MIN_LENGTH);
    expect(isDisplayTokenValid(weak, weak)).toBe(false);
  });

  it("refuses even a correct guess against a too-short configured token", () => {
    // The point: a short token is not merely weak here, it is INERT. There
    // is no supplied value that opens the route.
    expect(isDisplayTokenValid("short", "short")).toBe(false);
  });
});

describe("isDisplayTokenValid — fails closed on the REQUEST", () => {
  it("refuses a missing key", () => {
    expect(isDisplayTokenValid(undefined, GOOD)).toBe(false);
  });

  it("refuses an empty key", () => {
    expect(isDisplayTokenValid("", GOOD)).toBe(false);
  });

  it("refuses a wrong key of the same length", () => {
    const wrong = "a".repeat(16) + "c".repeat(16);
    expect(wrong).toHaveLength(GOOD.length);
    expect(isDisplayTokenValid(wrong, GOOD)).toBe(false);
  });

  it("refuses a correct PREFIX", () => {
    expect(isDisplayTokenValid(GOOD.slice(0, 20), GOOD)).toBe(false);
  });

  it("refuses the token with anything appended", () => {
    expect(isDisplayTokenValid(GOOD + "x", GOOD)).toBe(false);
  });

  it("differs in the LAST character only", () => {
    // Guards the constant-time loop specifically: an implementation that
    // short-circuits would still pass this, but one that compared only a
    // prefix would not.
    const offByLast = GOOD.slice(0, -1) + "z";
    expect(isDisplayTokenValid(offByLast, GOOD)).toBe(false);
  });

  it("is case sensitive", () => {
    expect(isDisplayTokenValid(GOOD.toUpperCase(), GOOD)).toBe(false);
  });
});
