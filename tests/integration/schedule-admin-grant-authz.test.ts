// Authz + behavior integration test for the Schedule Manager grant/revoke
// public action (setCoachScheduleAdmin). This is the anti-escalation
// boundary for the Master "Schedule Manager" feature: ONLY a real admin
// may flip another user's schedule_admin flag. A plain coach — and, just
// as importantly, a FLAGGED coach (a Schedule Manager) — must be rejected,
// so no one can self-grant or grant another coach.
//
// Mocks `@/auth` at file scope (vi.mock is hoisted) so the public wrapper
// resolves whatever session the scenario sets. Mirrors the
// admin-actions-authz.test.ts mock pattern.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, users } from "@/db/schema";
import {
  ensureFixtureUsers,
  truncateMutables,
  type FixtureUsers,
} from "./fixtures";

const authMock = vi.fn();
vi.mock("@/auth", () => ({
  auth: () => authMock(),
}));

// The public wrapper calls revalidatePath() after the mutation. Outside a
// Next.js request context that throws "static generation store missing",
// masking the success path. Stub it to a no-op (reject cases never reach
// it — requireRole throws first).
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

let fixtures: FixtureUsers;

beforeAll(async () => {
  fixtures = await ensureFixtureUsers();
});

beforeEach(async () => {
  await truncateMutables();
  authMock.mockReset();
  // Reset the plain coach's flag to a known OFF state before each test —
  // the grant/revoke tests mutate it and fixtures persist across the file.
  await db
    .update(users)
    .set({ scheduleAdmin: false })
    .where(eq(users.id, fixtures.coach.id));
});

function mockAsAdmin() {
  authMock.mockResolvedValue({
    user: {
      id: fixtures.admin.id,
      email: fixtures.admin.email,
      role: "admin",
    },
  });
}

function mockAsPlainCoach() {
  authMock.mockResolvedValue({
    user: {
      id: fixtures.coach.id,
      email: fixtures.coach.email,
      role: "coach",
      scheduleAdmin: false,
    },
  });
}

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

async function readScheduleAdmin(coachId: string): Promise<boolean> {
  const [row] = await db
    .select({ scheduleAdmin: users.scheduleAdmin })
    .from(users)
    .where(eq(users.id, coachId))
    .limit(1);
  return row?.scheduleAdmin ?? false;
}

describe("setCoachScheduleAdmin (public action) authz + behavior", () => {
  it("admin can GRANT — the flag flips to true in the db", async () => {
    mockAsAdmin();
    const { setCoachScheduleAdmin } = await import(
      "@/app/admin/coaches/[id]/actions"
    );

    expect(await readScheduleAdmin(fixtures.coach.id)).toBe(false);
    await setCoachScheduleAdmin({ coachId: fixtures.coach.id, enabled: true });
    expect(await readScheduleAdmin(fixtures.coach.id)).toBe(true);
  });

  it("admin can REVOKE — the flag flips back to false in the db", async () => {
    // Seed ON first.
    await db
      .update(users)
      .set({ scheduleAdmin: true })
      .where(eq(users.id, fixtures.coach.id));

    mockAsAdmin();
    const { setCoachScheduleAdmin } = await import(
      "@/app/admin/coaches/[id]/actions"
    );

    expect(await readScheduleAdmin(fixtures.coach.id)).toBe(true);
    await setCoachScheduleAdmin({ coachId: fixtures.coach.id, enabled: false });
    expect(await readScheduleAdmin(fixtures.coach.id)).toBe(false);
  });

  it("a PLAIN coach is rejected — requireRole('admin') redirects (throws), no write", async () => {
    mockAsPlainCoach();
    const { setCoachScheduleAdmin } = await import(
      "@/app/admin/coaches/[id]/actions"
    );

    await expect(
      // A plain coach trying to grant THEMSELVES — the self-escalation case.
      setCoachScheduleAdmin({ coachId: fixtures.coach.id, enabled: true }),
    ).rejects.toThrow();
    // The redirect fired before any DB write — flag is still off.
    expect(await readScheduleAdmin(fixtures.coach.id)).toBe(false);
  });

  it("a FLAGGED coach (Schedule Manager) is rejected — no other/self escalation", async () => {
    mockAsFlaggedCoach();
    const { setCoachScheduleAdmin } = await import(
      "@/app/admin/coaches/[id]/actions"
    );

    // A flagged coach trying to grant a PLAIN coach (escalate someone else).
    await expect(
      setCoachScheduleAdmin({ coachId: fixtures.coach.id, enabled: true }),
    ).rejects.toThrow();
    expect(await readScheduleAdmin(fixtures.coach.id)).toBe(false);

    // …and trying to KEEP their own flag set / re-grant themselves.
    await expect(
      setCoachScheduleAdmin({
        coachId: fixtures.flaggedCoach.id,
        enabled: true,
      }),
    ).rejects.toThrow();
  });

  it("writes an audit_log row attributed to the admin (grant then revoke)", async () => {
    mockAsAdmin();
    const { setCoachScheduleAdmin } = await import(
      "@/app/admin/coaches/[id]/actions"
    );

    await setCoachScheduleAdmin({ coachId: fixtures.coach.id, enabled: true });

    const grantRows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "user"),
          eq(auditLog.entityId, fixtures.coach.id),
        ),
      )
      .orderBy(desc(auditLog.ts));
    expect(grantRows.length).toBe(1);
    const grant = grantRows[0];
    expect(grant.actorUserId).toBe(fixtures.admin.id);
    // The audit_action enum stores "update"; the semantic action rides in
    // the diff's `after`.
    expect(grant.action).toBe("update");
    const grantDiff = grant.diff as {
      before?: { scheduleAdmin?: boolean };
      after?: { scheduleAdmin?: boolean; action?: string };
    };
    expect(grantDiff.after?.action).toBe("grant_schedule_admin");
    expect(grantDiff.before?.scheduleAdmin).toBe(false);
    expect(grantDiff.after?.scheduleAdmin).toBe(true);

    // Revoke → a second row with the revoke semantic action.
    await setCoachScheduleAdmin({ coachId: fixtures.coach.id, enabled: false });
    const allRows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "user"),
          eq(auditLog.entityId, fixtures.coach.id),
        ),
      )
      .orderBy(desc(auditLog.ts));
    expect(allRows.length).toBe(2);
    const revoke = allRows[0];
    expect(revoke.actorUserId).toBe(fixtures.admin.id);
    const revokeDiff = revoke.diff as {
      after?: { scheduleAdmin?: boolean; action?: string };
    };
    expect(revokeDiff.after?.action).toBe("revoke_schedule_admin");
    expect(revokeDiff.after?.scheduleAdmin).toBe(false);
  });
});
