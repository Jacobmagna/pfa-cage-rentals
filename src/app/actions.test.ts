// Unit test for requestMagicLink's send-failure handling (the warranty
// fix for Sentry PFAENGINE-4: a real coach hit a raw 500 when the Resend
// send threw). The contract we lock in:
//
//   - signIn success throws NEXT_REDIRECT → it MUST propagate untouched
//     (unstable_rethrow runs first), NOT be turned into ?error=send-failed.
//   - signIn real failure (non-redirect throw) → capture to Sentry AND
//     degrade to redirect("/?error=send-failed").
//
// We mock every module boundary actions.ts imports at file top so this
// stays a DB-free unit test under the default `vitest run` include
// (src/**/*.test.ts). @/db throws at import time without DATABASE_URL,
// so it MUST be mocked. next/navigation's redirect/unstable_rethrow are
// modeled to match the framework's throw-based control flow so we can
// assert the outcome deterministically. vi.mock is hoisted, so the
// action is imported dynamically after the mocks register (same
// convention as tests/integration/schedule-access-authz.test.ts).

import { beforeEach, describe, expect, it, vi } from "vitest";

// A stand-in for Next's NEXT_REDIRECT control-flow error. The real
// redirect()/signIn success path throws an error whose digest starts
// with "NEXT_REDIRECT"; unstable_rethrow keys off that to re-throw it.
class RedirectError extends Error {
  digest: string;
  constructor(url: string) {
    super("NEXT_REDIRECT");
    this.digest = `NEXT_REDIRECT;replace;${url};307;`;
  }
}

const signInMock = vi.fn();
vi.mock("@/auth", () => ({
  signIn: (...args: unknown[]) => signInMock(...args),
}));

// redirect() throws a RedirectError tagged with the target so tests can
// assert where we sent the user. unstable_rethrow re-throws control-flow
// errors (our RedirectError) and is a no-op for everything else — matching
// next/navigation's real behavior closely enough for this contract.
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectError(url);
  },
  unstable_rethrow: (err: unknown) => {
    if (err instanceof RedirectError) throw err;
  },
}));

const captureExceptionMock = vi.fn();
vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => captureExceptionMock(...args),
}));

// Boundaries that would otherwise pull in a live DB / rate-limit backend.
vi.mock("@/db", () => ({ db: {}, schema: {} }));
vi.mock("@/db/schema", () => ({ users: {} }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/authz", () => ({ requireSession: vi.fn() }));
vi.mock("@/lib/ratelimit", () => ({
  // Default: allow, so the flow reaches signIn. Overridable per test.
  checkMagicLinkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

function formDataWithEmail(email: string): FormData {
  const fd = new FormData();
  fd.set("email", email);
  return fd;
}

beforeEach(() => {
  signInMock.mockReset();
  captureExceptionMock.mockReset();
});

describe("requestMagicLink — send-failure handling", () => {
  it("propagates the success redirect (NEXT_REDIRECT) and never reports it as a send failure", async () => {
    // On success, signIn throws NEXT_REDIRECT to redirectTo: "/".
    signInMock.mockImplementation(() => {
      throw new RedirectError("/");
    });

    const { requestMagicLink } = await import("./actions");

    // The success redirect must escape untouched — target "/", not
    // "/?error=send-failed".
    await expect(
      requestMagicLink(formDataWithEmail("coach@example.com")),
    ).rejects.toMatchObject({
      digest: expect.stringContaining("NEXT_REDIRECT;replace;/;"),
    });
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it("captures a real send failure to Sentry and redirects to ?error=send-failed", async () => {
    // A non-redirect throw stands in for a Resend 429 cap / network error.
    const sendError = new Error("Resend 429: daily limit reached");
    signInMock.mockImplementation(() => {
      throw sendError;
    });

    const { requestMagicLink } = await import("./actions");

    await expect(
      requestMagicLink(formDataWithEmail("coach@example.com")),
    ).rejects.toMatchObject({
      digest: expect.stringContaining("NEXT_REDIRECT;replace;/?error=send-failed;"),
    });

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock).toHaveBeenCalledWith(sendError, {
      tags: { area: "magic-link-send" },
      extra: { email: "coach@example.com" },
    });
  });
});
