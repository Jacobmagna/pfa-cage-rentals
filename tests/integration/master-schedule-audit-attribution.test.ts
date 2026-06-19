// Owner-accountability integration test for the Master "Schedule Manager"
// surface. When a flagged coach (scheduleAdmin) creates a rental or a cage
// block through the widened public action, the audit_log row MUST attribute
// the action to that coach — NOT the admin, NOT null. This is the audit
// trail the gym owner relies on to see which Schedule Manager did what.
//
// We drive the PUBLIC wrappers (which call requireScheduleAccess() and then
// pass session.user into the internal fn), so the actorUserId in audit_log
// is whatever the mocked session resolves to. Mocking auth() as the flagged
// coach is the whole point: it proves the wrapper threads the real caller's
// id into the audit row.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog } from "@/db/schema";
import {
  ensureFixtureUsers,
  getSeededResources,
  truncateMutables,
  type FixtureUsers,
} from "./fixtures";

const authMock = vi.fn();
vi.mock("@/auth", () => ({
  auth: () => authMock(),
}));

// The public wrappers call revalidatePath() after the mutation. Outside a
// Next.js request context that throws "static generation store missing",
// which would mask the success path we're actually testing. Stub it to a
// no-op — cache revalidation isn't what this suite asserts.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

let fixtures: FixtureUsers;
let seeded: Awaited<ReturnType<typeof getSeededResources>>;

beforeAll(async () => {
  fixtures = await ensureFixtureUsers();
  seeded = await getSeededResources();
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

function tomorrowAt(hour: number, minute = 0): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(hour, minute, 0, 0);
  return d;
}

describe("audit_log attributes a Schedule Manager's action to the manager", () => {
  it("createSession by the flagged coach records actorUserId = flaggedCoach.id", async () => {
    mockAsFlaggedCoach();
    const { createSession } = await import("@/app/admin/sessions/actions");

    const created = (await createSession({
      coachId: fixtures.coach.id,
      resourceId: seeded.cage1.id,
      startAt: tomorrowAt(10),
      endAt: tomorrowAt(11),
    })) as { id: string };
    expect(created.id).toBeTruthy();

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "session"),
          eq(auditLog.entityId, created.id),
          eq(auditLog.action, "create"),
        ),
      );

    expect(audit).toBeDefined();
    // The core assertion: the manager — not the admin, not null — owns it.
    expect(audit.actorUserId).toBe(fixtures.flaggedCoach.id);
    expect(audit.actorUserId).not.toBe(fixtures.admin.id);
    expect(audit.actorUserId).not.toBeNull();
    expect(audit.entityType).toBe("session");
    expect(audit.action).toBe("create");
  });

  it("createBlock by the flagged coach records actorUserId = flaggedCoach.id", async () => {
    mockAsFlaggedCoach();
    const { createBlock } = await import("@/app/admin/schedule/actions");

    const created = (await createBlock({
      resourceId: seeded.cage1.id,
      startAt: tomorrowAt(13),
      endAt: tomorrowAt(14),
      reason: "Manager-created block",
    })) as { id: string };
    expect(created.id).toBeTruthy();

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "block"),
          eq(auditLog.entityId, created.id),
          eq(auditLog.action, "create"),
        ),
      );

    expect(audit).toBeDefined();
    expect(audit.actorUserId).toBe(fixtures.flaggedCoach.id);
    expect(audit.actorUserId).not.toBe(fixtures.admin.id);
    expect(audit.actorUserId).not.toBeNull();
    expect(audit.entityType).toBe("block");
    expect(audit.action).toBe("create");
  });
});
