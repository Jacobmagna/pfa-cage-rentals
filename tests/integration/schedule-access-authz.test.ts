// Authz-layer integration test for the requireScheduleAccess() guard
// (src/lib/authz.ts) — the gate behind the Master "Schedule Manager"
// surface. Mocks `@/auth` so we can drive the guard with whatever
// session shape the scenario needs.
//
// Why a separate file: vi.mock is hoisted to file scope, so mocking
// `@/auth` here keeps the mock from shadowing the real auth import in
// suites that exercise the internal logic directly. One file per mock
// surface keeps blame readable (same convention as
// admin-actions-authz.test.ts).
//
// Contract under test:
//   - admin                       → returns the session (passes)
//   - coach with scheduleAdmin    → returns the session (passes)
//   - plain coach (no flag)       → redirect("/coach"), which throws

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

describe("requireScheduleAccess", () => {
  it("returns the session for an admin", async () => {
    authMock.mockResolvedValue({
      user: {
        id: fixtures.admin.id,
        email: fixtures.admin.email,
        role: "admin",
      },
    });

    // Dynamic import AFTER vi.mock is registered so the guard resolves
    // the mocked `@/auth`. Top-level static imports would race the mock
    // setup in some module-graph orderings.
    const { requireScheduleAccess } = await import("@/lib/authz");

    const session = await requireScheduleAccess();
    expect(session.user.id).toBe(fixtures.admin.id);
  });

  it("returns the session for a flagged coach (scheduleAdmin: true)", async () => {
    authMock.mockResolvedValue({
      user: {
        id: fixtures.flaggedCoach.id,
        email: fixtures.flaggedCoach.email,
        role: "coach",
        scheduleAdmin: true,
      },
    });

    const { requireScheduleAccess } = await import("@/lib/authz");

    const session = await requireScheduleAccess();
    expect(session.user.id).toBe(fixtures.flaggedCoach.id);
  });

  it("rejects a plain coach (role coach, scheduleAdmin false) — redirect throws", async () => {
    authMock.mockResolvedValue({
      user: {
        id: fixtures.coach.id,
        email: fixtures.coach.email,
        role: "coach",
        scheduleAdmin: false,
      },
    });

    const { requireScheduleAccess } = await import("@/lib/authz");

    // redirect() from next/navigation throws NEXT_REDIRECT. We only care
    // that the guard never returned a session for an unflagged coach.
    await expect(requireScheduleAccess()).rejects.toThrow();
  });

  it("rejects a plain coach with scheduleAdmin undefined (absent flag) — redirect throws", async () => {
    authMock.mockResolvedValue({
      user: {
        id: fixtures.coach.id,
        email: fixtures.coach.email,
        role: "coach",
        // scheduleAdmin intentionally omitted
      },
    });

    const { requireScheduleAccess } = await import("@/lib/authz");

    await expect(requireScheduleAccess()).rejects.toThrow();
  });
});
