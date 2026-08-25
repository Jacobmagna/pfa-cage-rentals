// Boundary integration test: the Schedule Manager widening is SCOPED.
// Granting a coach scheduleAdmin opens ONLY the schedule mutation actions
// (cage blocks, cage rentals, program schedule). It must NOT leak into
// money (payments), roster (athletes), or the admin-only session-removal
// approval workflow — those stay requireRole("admin").
//
// We mock auth() as the FLAGGED coach (the strongest non-admin) and assert
// each of these still rejects. If any of them passed for a flagged coach,
// the widening would have over-reached.

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

function mockAsFlaggedCoach() {
  authMock.mockResolvedValue({
    user: {
      id: fixtures.flaggedCoach.id,
      email: fixtures.flaggedCoach.email,
      role: "coach",
      scheduleAdmin: true,
    },
  });
}

describe("admin-only actions still reject a flagged (scheduleAdmin) coach", () => {
  it("approveSessionRemoval (left admin-only) rejects the flagged coach", async () => {
    mockAsFlaggedCoach();
    const { approveSessionRemoval } = await import(
      "@/app/admin/sessions/actions"
    );
    // requireRole("admin") redirects → throws, before touching the request.
    await expect(approveSessionRemoval("any-request-id")).rejects.toThrow();
  });

  // 0r(1): the substitute reassign MUTATES THE SCHEDULE, which is exactly
  // what scheduleAdmin was widened to allow — so it is the most plausible
  // place for the widening to over-reach. It is deliberately admin-only:
  // it reads posted hour-logs (pay records) to decide whether the move is
  // allowed, and block membership drives the no-show derivation. It also
  // renders only on /admin/hour-log/schedule, which is itself
  // requireRole("admin") — so the gate matches its surface.
  it("reassignBlockToLoggedCoach (schedule + pay-adjacent) rejects the flagged coach", async () => {
    mockAsFlaggedCoach();
    const { reassignBlockToLoggedCoach } = await import(
      "@/app/admin/hour-log/actions"
    );
    // 🔴 A bare .rejects.toThrow() would pass for the WRONG REASON here: a
    // bogus block id throws ProgramScheduleBlockNotFoundError too, so the
    // test would stay green even if the gate were loosened to
    // requireScheduleAccess. Assert on WHICH error: authz must reject
    // BEFORE any DB lookup, so reaching the block query at all is a
    // failure. (Discipline rule 21 — two conditions returning the same
    // answer leaves neither under test.)
    const { ProgramScheduleBlockNotFoundError } = await import("@/lib/errors");
    const err = await reassignBlockToLoggedCoach({
      blockId: "any-block-id",
      fromCoachId: "any-from",
      toCoachId: "any-to",
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).not.toBeNull();
    expect(err).not.toBeInstanceOf(ProgramScheduleBlockNotFoundError);
  });

  it("recordPayment (money) rejects the flagged coach", async () => {
    mockAsFlaggedCoach();
    const { recordPayment } = await import("@/app/admin/payments/actions");
    await expect(recordPayment({})).rejects.toThrow();
  });

  it("addAthlete (roster) rejects the flagged coach", async () => {
    mockAsFlaggedCoach();
    const { addAthlete } = await import(
      "@/app/admin/attendance/roster/actions"
    );
    await expect(addAthlete({})).rejects.toThrow();
  });
});
