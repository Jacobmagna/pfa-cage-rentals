// Authz-layer integration test for the public admin session actions.
// Mocks `@/auth` so we can drive `requireRole("admin")` with whatever
// session shape the scenario needs. The rest of the suite tests the
// internal logic directly, so this file is just the public wrapper.
//
// Why a separate file: vi.mock is hoisted to file scope. Mocking
// `@/auth` in session-actions.test.ts would shadow the real auth
// import across every test in that file, even ones that don't care
// about authz — confusing. One file per mock surface keeps blame
// readable.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureFixtureUsers, truncateMutables, type FixtureUsers } from "./fixtures";

const authMock = vi.fn();
vi.mock("@/auth", () => ({
  auth: () => authMock(),
}));

let fixtures: FixtureUsers;

beforeAll(async () => {
  fixtures = await ensureFixtureUsers();
});

beforeEach(async () => {
  await truncateMutables();
  authMock.mockReset();
});

describe("createSession (public action) authz", () => {
  it("rejects a coach session — requireRole('admin') redirects, which throws", async () => {
    authMock.mockResolvedValue({
      user: {
        id: fixtures.coach.id,
        email: fixtures.coach.email,
        role: "coach",
      },
    });

    // Dynamic import AFTER vi.mock is registered so the wrapper resolves
    // the mocked `@/auth`. Top-level static imports would race the mock
    // setup in some module-graph orderings.
    const { createSession } = await import("@/app/admin/sessions/actions");

    // redirect() from next/navigation throws NEXT_REDIRECT. We don't
    // care about the exact error class — only that the action never
    // got past the role check to attempt a DB write.
    await expect(
      createSession({
        coachId: fixtures.coach.id,
        resourceId: "does-not-matter",
        startAt: new Date(),
        endAt: new Date(),
      }),
    ).rejects.toThrow();
  });
});
