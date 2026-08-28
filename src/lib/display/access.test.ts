import { describe, expect, it } from "vitest";
import {
  DISPLAY_PASSWORD_MIN_LENGTH,
  displayCookieValue,
  isDisplayCookieValid,
  isDisplayPasswordConfigured,
  isDisplayPasswordValid,
} from "./access";

// The gate on the ONLY publicly reachable schedule URL in the product. Every
// test below is about one of two questions: can someone who should not be in
// get in, and can the facility lock ITSELF out.

const SECRET = "a".repeat(24);
const PASSWORD = "green cage tuesday";

describe("isDisplayPasswordConfigured — the dormant state", () => {
  it("is NOT configured when the password is absent", () => {
    expect(isDisplayPasswordConfigured(undefined)).toBe(false);
  });

  it("is NOT configured for an empty string", () => {
    // 🔴 THE ACTUAL DANGEROUS MISCONFIGURATION. `DISPLAY_PASSWORD=` in a
    // dashboard looks set, and a gate that reads "no password → allow" would
    // publish the facility schedule while appearing configured.
    expect(isDisplayPasswordConfigured("")).toBe(false);
  });

  it("is NOT configured below the minimum length", () => {
    expect(isDisplayPasswordConfigured("a".repeat(DISPLAY_PASSWORD_MIN_LENGTH - 1))).toBe(
      false,
    );
  });

  it("is configured at exactly the minimum length", () => {
    expect(isDisplayPasswordConfigured("a".repeat(DISPLAY_PASSWORD_MIN_LENGTH))).toBe(true);
  });
});

describe("isDisplayPasswordValid", () => {
  it("accepts the configured password", () => {
    expect(isDisplayPasswordValid(PASSWORD, PASSWORD)).toBe(true);
  });

  it("rejects a wrong password", () => {
    expect(isDisplayPasswordValid("wrong password here", PASSWORD)).toBe(false);
  });

  it("rejects a PREFIX of the password", () => {
    // Guards the length check in constantTimeEquals: a prefix must not pass.
    expect(isDisplayPasswordValid(PASSWORD.slice(0, -1), PASSWORD)).toBe(false);
  });

  it("rejects an empty submission", () => {
    expect(isDisplayPasswordValid("", PASSWORD)).toBe(false);
    expect(isDisplayPasswordValid(undefined, PASSWORD)).toBe(false);
  });

  it("🔴 rejects EVERYTHING when the gate is not configured", () => {
    // Including the empty box, which is what a bot would send first.
    expect(isDisplayPasswordValid("", undefined)).toBe(false);
    expect(isDisplayPasswordValid("anything", undefined)).toBe(false);
    expect(isDisplayPasswordValid("", "")).toBe(false);
    expect(isDisplayPasswordValid("short", "short")).toBe(false);
  });

  it("trims surrounding whitespace on what was TYPED, never on the secret", () => {
    // A television's on-screen keyboard adds a trailing space with depressing
    // regularity, and the resulting failure is invisible to the person typing.
    expect(isDisplayPasswordValid(`  ${PASSWORD} `, PASSWORD)).toBe(true);
    // But the configured value is compared as-is: a password stored WITH
    // padding is a different password, and silently trimming the secret would
    // mean two different env values unlock the same board.
    expect(isDisplayPasswordValid(PASSWORD, ` ${PASSWORD} `)).toBe(false);
  });
});

describe("the cookie", () => {
  it("round-trips a cookie it issued", () => {
    expect(isDisplayCookieValid(displayCookieValue(SECRET), SECRET)).toBe(true);
  });

  it("🔴 is NOT the password, and does not contain it", () => {
    // The property that makes it safe to leave on a shared television.
    const value = displayCookieValue(SECRET);
    expect(value).not.toContain(PASSWORD);
    expect(value).not.toContain(SECRET);
  });

  it("rejects a cookie signed with a DIFFERENT secret", () => {
    // Rotating DISPLAY_TOKEN must invalidate every issued cookie.
    expect(isDisplayCookieValid(displayCookieValue("b".repeat(24)), SECRET)).toBe(false);
  });

  it("rejects a forged or absent cookie", () => {
    expect(isDisplayCookieValid("not-a-real-cookie", SECRET)).toBe(false);
    expect(isDisplayCookieValid(undefined, SECRET)).toBe(false);
    expect(isDisplayCookieValid("", SECRET)).toBe(false);
  });

  it("🔴 fails CLOSED when the signing secret is missing or too short", () => {
    // Otherwise dropping DISPLAY_TOKEN from the environment would turn the
    // cookie check into "any value is accepted" — the route would look gated
    // and be wide open.
    const value = displayCookieValue(SECRET);
    expect(isDisplayCookieValid(value, undefined)).toBe(false);
    expect(isDisplayCookieValid(value, "")).toBe(false);
    expect(isDisplayCookieValid(value, "a".repeat(23))).toBe(false);
  });

  it("is stable for one secret, so a TV is not logged out by a redeploy", () => {
    // The cookie carries no timestamp and no per-session state on purpose:
    // a value that changed per render would log the wall out on every deploy.
    expect(displayCookieValue(SECRET)).toBe(displayCookieValue(SECRET));
  });
});
