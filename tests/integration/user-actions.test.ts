// Integration tests for J9 account-deletion. Hits the real Neon dev
// branch. Same direct-internal pattern as session-actions.test.ts —
// we call `deleteCoachInternal` directly with a synthetic admin actor
// instead of through the public wrapper; the wrapper's only extra
// behavior is requireRole + revalidatePath (the former is covered
// generically in admin-actions-authz.test.ts, the latter has no
// observable side-effect in node test).
//
// Throwaway coach per test (unique email) so the row is created from
// scratch and the soft-delete leaves no fixture pollution. truncateMutables
// only resets the mutable session/block tables; user rows are durable.

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  accounts,
  auditLog,
  sessions as authSessions,
  sessionsBilling,
  users,
  verificationTokens,
} from "@/db/schema";
import {
  anonymizedEmailFor,
  deleteCoachInternal,
  FORMER_COACH_NAME,
} from "@/lib/server/user-actions";
import { createSessionInternal } from "@/lib/server/session-actions";
import {
  CannotDeleteAdminError,
  CoachAlreadyDeletedError,
  CoachNotFoundError,
} from "@/lib/errors";
import {
  ensureFixtureUsers,
  getSeededResources,
  truncateMutables,
  type FixtureUsers,
} from "./fixtures";

let fixtures: FixtureUsers;
let seeded: Awaited<ReturnType<typeof getSeededResources>>;

beforeAll(async () => {
  fixtures = await ensureFixtureUsers();
  seeded = await getSeededResources();
});

beforeEach(async () => {
  await truncateMutables();
});

function uniqueEmail(label: string): string {
  return `j9-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.invalid`;
}

async function createThrowawayCoach(name = "Throwaway Coach") {
  const [row] = await db
    .insert(users)
    .values({ email: uniqueEmail("coach"), name, role: "coach" })
    .returning();
  return row;
}

function tomorrowAt(hour: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(hour, 0, 0, 0);
  return d;
}

describe("deleteCoachInternal", () => {
  it("anonymizes name + email, sets deletedAt, writes audit row", async () => {
    const coach = await createThrowawayCoach("Patrick Roe");
    const originalEmail = coach.email;

    const before = new Date();
    const updated = await deleteCoachInternal(fixtures.admin, {
      coachId: coach.id,
    });
    const after = new Date();

    expect(updated.name).toBe(FORMER_COACH_NAME);
    expect(updated.email).toBe(anonymizedEmailFor(coach.id));
    expect(updated.image).toBeNull();
    expect(updated.deletedAt).toBeInstanceOf(Date);
    expect(updated.deletedAt!.getTime()).toBeGreaterThanOrEqual(
      before.getTime(),
    );
    expect(updated.deletedAt!.getTime()).toBeLessThanOrEqual(after.getTime());

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "user"),
          eq(auditLog.entityId, coach.id),
          eq(auditLog.action, "delete"),
        ),
      );
    expect(audit).toBeDefined();
    expect(audit.actorUserId).toBe(fixtures.admin.id);

    // Audit's before-snapshot captures the pre-anonymization identity
    // so a future forensic lookup can recover what we had on file.
    const diff = audit.diff as { before: Record<string, unknown> };
    expect(diff.before.email).toBe(originalEmail);
    expect(diff.before.name).toBe("Patrick Roe");
  });

  it("preserves the coach's billing session rows", async () => {
    const coach = await createThrowawayCoach();
    const session = await createSessionInternal(fixtures.admin, {
      coachId: coach.id,
      resourceId: seeded.cage1.id,
      startAt: tomorrowAt(10),
      endAt: tomorrowAt(11),
      useType: "hitting",
    });

    await deleteCoachInternal(fixtures.admin, { coachId: coach.id });

    const [stillThere] = await db
      .select()
      .from(sessionsBilling)
      .where(eq(sessionsBilling.id, session.id));
    expect(stillThere).toBeDefined();
    expect(stillThere.coachId).toBe(coach.id);
  });

  it("revokes any live Auth.js sessions for the coach", async () => {
    const coach = await createThrowawayCoach();
    await db.insert(authSessions).values({
      sessionToken: `j9-test-token-${Date.now()}`,
      userId: coach.id,
      expires: new Date(Date.now() + 60_000),
    });

    await deleteCoachInternal(fixtures.admin, { coachId: coach.id });

    const remaining = await db
      .select()
      .from(authSessions)
      .where(eq(authSessions.userId, coach.id));
    expect(remaining).toHaveLength(0);
  });

  it("revokes linked OAuth accounts so re-sign-in creates a fresh user", async () => {
    const coach = await createThrowawayCoach();
    await db.insert(accounts).values({
      userId: coach.id,
      type: "oauth",
      provider: "google",
      providerAccountId: `j9-google-${Date.now()}`,
    });

    await deleteCoachInternal(fixtures.admin, { coachId: coach.id });

    const remaining = await db
      .select()
      .from(accounts)
      .where(eq(accounts.userId, coach.id));
    expect(remaining).toHaveLength(0);
  });

  it("clears pending verification tokens for the original email", async () => {
    const coach = await createThrowawayCoach();
    const originalEmail = coach.email;
    await db.insert(verificationTokens).values({
      identifier: originalEmail,
      token: `j9-test-vt-${Date.now()}`,
      expires: new Date(Date.now() + 60_000),
    });

    await deleteCoachInternal(fixtures.admin, { coachId: coach.id });

    const remaining = await db
      .select()
      .from(verificationTokens)
      .where(eq(verificationTokens.identifier, originalEmail));
    expect(remaining).toHaveLength(0);
  });

  it("rejects CoachNotFoundError for a non-existent id", async () => {
    await expect(
      deleteCoachInternal(fixtures.admin, {
        coachId: "00000000-0000-0000-0000-000000000000",
      }),
    ).rejects.toBeInstanceOf(CoachNotFoundError);
  });

  it("refuses to delete an admin via CannotDeleteAdminError", async () => {
    await expect(
      deleteCoachInternal(fixtures.admin, { coachId: fixtures.admin.id }),
    ).rejects.toBeInstanceOf(CannotDeleteAdminError);

    // Admin row is untouched.
    const [admin] = await db
      .select()
      .from(users)
      .where(eq(users.id, fixtures.admin.id));
    expect(admin.deletedAt).toBeNull();
    expect(admin.role).toBe("admin");
  });

  it("refuses to delete an already-deleted coach", async () => {
    const coach = await createThrowawayCoach();
    await deleteCoachInternal(fixtures.admin, { coachId: coach.id });

    await expect(
      deleteCoachInternal(fixtures.admin, { coachId: coach.id }),
    ).rejects.toBeInstanceOf(CoachAlreadyDeletedError);
  });
});
