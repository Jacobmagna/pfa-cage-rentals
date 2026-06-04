import { describe, expect, it } from "vitest";
import { decideSignIn } from "./auth-access";

describe("decideSignIn", () => {
  it("rejects an empty email even when isAdmin is true", () => {
    expect(decideSignIn({ email: "", isAdmin: true, userExists: true })).toBe(
      false,
    );
  });

  it("rejects a null email", () => {
    expect(
      decideSignIn({ email: null, isAdmin: false, userExists: false }),
    ).toBe(false);
  });

  it("rejects an undefined email", () => {
    expect(
      decideSignIn({ email: undefined, isAdmin: false, userExists: false }),
    ).toBe(false);
  });

  it("rejects a whitespace-only email", () => {
    expect(
      decideSignIn({ email: "   ", isAdmin: true, userExists: true }),
    ).toBe(false);
  });

  it("allows an admin email even when no user row exists yet", () => {
    expect(
      decideSignIn({
        email: "admin@example.com",
        isAdmin: true,
        userExists: false,
      }),
    ).toBe(true);
  });

  it("allows an existing (invited) user", () => {
    expect(
      decideSignIn({
        email: "coach@example.com",
        isAdmin: false,
        userExists: true,
      }),
    ).toBe(true);
  });

  it("rejects an unknown email (not admin, no user row)", () => {
    expect(
      decideSignIn({
        email: "random@gmail.com",
        isAdmin: false,
        userExists: false,
      }),
    ).toBe(false);
  });
});
