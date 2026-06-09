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
import { ZodError } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  accounts,
  auditLog,
  sessions as authSessions,
  coachRateOverrides,
  sessionsBilling,
  users,
  verificationTokens,
} from "@/db/schema";
import {
  addCoachInternal,
  anonymizedEmailFor,
  CoachEmailTakenError,
  deleteCoachInternal,
  FORMER_COACH_NAME,
  mergeSyntheticCoachInternal,
} from "@/lib/server/user-actions";
import { createSessionInternal } from "@/lib/server/session-actions";
import { upsertRateOverrideInternal } from "@/lib/server/rate-override-actions";
import {
  CannotDeleteAdminError,
  CoachAlreadyDeletedError,
  CoachNotFoundError,
  MergeSourceNotSyntheticError,
  MergeTargetSameAsSourceError,
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

// ---- mergeSyntheticCoachInternal ---------------------------------------
//
// Synthetic = imported via historical-import flow (email
// "historical-<slug>@imported.local"). Merge re-points every
// sessions_billing.coach_id source→target, drops any source rate
// overrides, hard-deletes the source user. No transaction (neon-http);
// re-running on partial failure is the recovery path.

async function createSyntheticCoach(canonicalName = "imported-coach") {
  // syntheticEmailFor lives in src/lib/import/commit.ts but inlining
  // the literal pattern here keeps this test independent of that
  // module's signature.
  const slug = `${canonicalName}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const [row] = await db
    .insert(users)
    .values({
      email: `historical-${slug}@imported.local`,
      name: canonicalName,
      role: "coach",
    })
    .returning();
  return row;
}

describe("mergeSyntheticCoachInternal", () => {
  it("re-points sessions, drops source overrides, hard-deletes source, audits", async () => {
    const source = await createSyntheticCoach("Imported David");
    const target = await createThrowawayCoach("Real David");

    // Two sessions on the synthetic.
    const s1 = await createSessionInternal(fixtures.admin, {
      coachId: source.id,
      resourceId: seeded.cage1.id,
      startAt: tomorrowAt(10),
      endAt: tomorrowAt(11),
    });
    const s2 = await createSessionInternal(fixtures.admin, {
      coachId: source.id,
      resourceId: seeded.cage1.id,
      startAt: tomorrowAt(13),
      endAt: tomorrowAt(14),
    });

    // A rate override on the synthetic — should be dropped.
    await upsertRateOverrideInternal(fixtures.admin, {
      coachId: source.id,
      resourceType: "cage",
      ratePer30MinCents: 1500,
    });

    const result = await mergeSyntheticCoachInternal(
      fixtures.admin,
      source.id,
      target.id,
    );
    expect(result.movedSessions).toBe(2);

    // Sessions re-pointed.
    const sourceSessions = await db
      .select()
      .from(sessionsBilling)
      .where(eq(sessionsBilling.coachId, source.id));
    expect(sourceSessions).toHaveLength(0);

    const targetSessions = await db
      .select()
      .from(sessionsBilling)
      .where(eq(sessionsBilling.coachId, target.id));
    const targetIds = targetSessions.map((s) => s.id).sort();
    expect(targetIds).toEqual([s1.id, s2.id].sort());

    // Source overrides dropped.
    const remainingOverrides = await db
      .select()
      .from(coachRateOverrides)
      .where(eq(coachRateOverrides.coachId, source.id));
    expect(remainingOverrides).toHaveLength(0);

    // Source user hard-deleted (not soft).
    const sourceUser = await db
      .select()
      .from(users)
      .where(eq(users.id, source.id));
    expect(sourceUser).toHaveLength(0);

    // Audit entry captured.
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "user"),
          eq(auditLog.entityId, source.id),
          eq(auditLog.action, "delete"),
        ),
      );
    expect(audit).toBeDefined();
    expect(audit.actorUserId).toBe(fixtures.admin.id);
    const diff = audit.diff as {
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    };
    expect(diff.before.email).toBe(source.email);
    expect(diff.after.mergedInto).toBe(target.id);
    expect(diff.after.sessionsMoved).toBe(2);
  });

  it("snapshotted ratePer30MinCents on moved sessions is preserved", async () => {
    // Re-pointing the coach_id doesn't recompute rate from the target's
    // overrides; the source's snapshot wins because it was stamped at
    // write time. Belt-and-suspenders against any future refactor that
    // tries to be "helpful" mid-merge.
    const source = await createSyntheticCoach("imported-rate");
    const target = await createThrowawayCoach("Real Rate");

    await upsertRateOverrideInternal(fixtures.admin, {
      coachId: source.id,
      resourceType: "cage",
      ratePer30MinCents: 1500,
    });
    const session = await createSessionInternal(fixtures.admin, {
      coachId: source.id,
      resourceId: seeded.cage1.id,
      startAt: tomorrowAt(10),
      endAt: tomorrowAt(11),
    });
    expect(session.ratePer30MinCents).toBe(1500);

    // Target has a different override at 2500.
    await upsertRateOverrideInternal(fixtures.admin, {
      coachId: target.id,
      resourceType: "cage",
      ratePer30MinCents: 2500,
    });

    await mergeSyntheticCoachInternal(fixtures.admin, source.id, target.id);

    const [moved] = await db
      .select()
      .from(sessionsBilling)
      .where(eq(sessionsBilling.id, session.id));
    expect(moved.coachId).toBe(target.id);
    expect(moved.ratePer30MinCents).toBe(1500);
  });

  it("succeeds with zero sessions and zero overrides on the synthetic", async () => {
    const source = await createSyntheticCoach("empty-synthetic");
    const target = await createThrowawayCoach("Real Target");

    const result = await mergeSyntheticCoachInternal(
      fixtures.admin,
      source.id,
      target.id,
    );
    expect(result.movedSessions).toBe(0);

    const sourceUser = await db
      .select()
      .from(users)
      .where(eq(users.id, source.id));
    expect(sourceUser).toHaveLength(0);
  });

  it("rejects merge when source is not synthetic", async () => {
    const source = await createThrowawayCoach("Real Coach (not synthetic)");
    const target = await createThrowawayCoach("Other Real Coach");

    await expect(
      mergeSyntheticCoachInternal(fixtures.admin, source.id, target.id),
    ).rejects.toBeInstanceOf(MergeSourceNotSyntheticError);

    // Source row is untouched.
    const [stillThere] = await db
      .select()
      .from(users)
      .where(eq(users.id, source.id));
    expect(stillThere).toBeDefined();
  });

  it("rejects merge when source === target", async () => {
    const source = await createSyntheticCoach("self-merge");
    await expect(
      mergeSyntheticCoachInternal(fixtures.admin, source.id, source.id),
    ).rejects.toBeInstanceOf(MergeTargetSameAsSourceError);
  });

  it("rejects merge when source id does not exist", async () => {
    const target = await createThrowawayCoach();
    await expect(
      mergeSyntheticCoachInternal(
        fixtures.admin,
        "00000000-0000-0000-0000-000000000000",
        target.id,
      ),
    ).rejects.toBeInstanceOf(CoachNotFoundError);
  });

  it("rejects merge when target id does not exist", async () => {
    const source = await createSyntheticCoach("orphan-target");
    await expect(
      mergeSyntheticCoachInternal(
        fixtures.admin,
        source.id,
        "00000000-0000-0000-0000-000000000000",
      ),
    ).rejects.toBeInstanceOf(CoachNotFoundError);
  });

  it("is idempotent when re-run after a successful merge", async () => {
    // Mid-merge partial failure (no transactions on neon-http) is the
    // recovery scenario documented in user-actions.ts. After a clean
    // run, the source user no longer exists; re-running surfaces
    // CoachNotFoundError, which is the expected admin signal that the
    // merge is already done.
    const source = await createSyntheticCoach("idempotent");
    const target = await createThrowawayCoach();
    await createSessionInternal(fixtures.admin, {
      coachId: source.id,
      resourceId: seeded.cage1.id,
      startAt: tomorrowAt(10),
      endAt: tomorrowAt(11),
    });

    await mergeSyntheticCoachInternal(fixtures.admin, source.id, target.id);

    await expect(
      mergeSyntheticCoachInternal(fixtures.admin, source.id, target.id),
    ).rejects.toBeInstanceOf(CoachNotFoundError);
  });

  it("recovers from simulated partial failure: sessions already moved, source still present", async () => {
    // Simulate a crash AFTER step 1 (sessions moved) but BEFORE step 3
    // (source user delete). Manually replay step 1, then run merge
    // again — it should pick up steps 2/3 cleanly.
    const source = await createSyntheticCoach("partial-failure");
    const target = await createThrowawayCoach();
    const session = await createSessionInternal(fixtures.admin, {
      coachId: source.id,
      resourceId: seeded.cage1.id,
      startAt: tomorrowAt(10),
      endAt: tomorrowAt(11),
    });

    // Step 1 done manually (no audit).
    await db
      .update(sessionsBilling)
      .set({ coachId: target.id })
      .where(eq(sessionsBilling.coachId, source.id));

    // Run merge → step 1 is a no-op (0 sessions left to move),
    // steps 2/3 clean up the orphan synthetic. Reports 0 moved this
    // run, which is the truth.
    const result = await mergeSyntheticCoachInternal(
      fixtures.admin,
      source.id,
      target.id,
    );
    expect(result.movedSessions).toBe(0);

    const [moved] = await db
      .select()
      .from(sessionsBilling)
      .where(eq(sessionsBilling.id, session.id));
    expect(moved.coachId).toBe(target.id);

    const sourceUser = await db
      .select()
      .from(users)
      .where(eq(users.id, source.id));
    expect(sourceUser).toHaveLength(0);
  });
});

// ---- addCoachInternal (invite path) ------------------------------------
//
// Same direct-internal pattern as above — call addCoachInternal with the
// synthetic admin actor instead of through the requireRole-gated
// addCoachAction wrapper. The wrapper's only extra behavior is
// requireRole + Result reshaping; the gate is covered generically in
// admin-actions-authz.test.ts.

describe("addCoachInternal", () => {
  it("inserts a fresh coach row (role=coach, not deleted) and audits create", async () => {
    const email = uniqueEmail("addcoach");
    const { user, mode } = await addCoachInternal(fixtures.admin, {
      name: "Brand New Coach",
      email,
    });

    expect(mode).toBe("created");
    expect(user.email).toBe(email);
    expect(user.name).toBe("Brand New Coach");
    expect(user.role).toBe("coach");
    expect(user.deletedAt).toBeNull();

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "user"),
          eq(auditLog.entityId, user.id),
          eq(auditLog.action, "create"),
        ),
      );
    expect(audit).toBeDefined();
    expect(audit.actorUserId).toBe(fixtures.admin.id);
  });

  it("lowercases + trims the email before insert", async () => {
    const base = uniqueEmail("MixedCase");
    const { user } = await addCoachInternal(fixtures.admin, {
      name: "  Spaced Name  ",
      email: `  ${base.toUpperCase()}  `,
    });
    expect(user.email).toBe(base.toLowerCase());
    expect(user.name).toBe("Spaced Name");
  });

  it("rejects when an ACTIVE user already owns the email", async () => {
    const coach = await createThrowawayCoach("Existing Active");
    await expect(
      addCoachInternal(fixtures.admin, {
        name: "Dup Attempt",
        email: coach.email.toUpperCase(),
      }),
    ).rejects.toBeInstanceOf(CoachEmailTakenError);
  });

  it("restores a soft-deleted coach matching the email (re-authorize)", async () => {
    // Simulate the legacy-coach purge, which sets ONLY deletedAt and
    // preserves the real email — so re-adding by that email should
    // restore the SAME row rather than insert a new one.
    const coach = await createThrowawayCoach("Purged Coach");
    await db
      .update(users)
      .set({ deletedAt: new Date(), role: "coach" })
      .where(eq(users.id, coach.id));

    const { user, mode } = await addCoachInternal(fixtures.admin, {
      name: "Welcomed Back",
      email: coach.email,
    });

    expect(mode).toBe("restored");
    expect(user.id).toBe(coach.id);
    expect(user.deletedAt).toBeNull();
    expect(user.role).toBe("coach");
    expect(user.name).toBe("Welcomed Back");

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "user"),
          eq(auditLog.entityId, coach.id),
          eq(auditLog.action, "update"),
        ),
      );
    expect(audit).toBeDefined();
    expect(audit.actorUserId).toBe(fixtures.admin.id);
  });

  it("rejects an invalid email via ZodError", async () => {
    await expect(
      addCoachInternal(fixtures.admin, {
        name: "Bad Email",
        email: "not-an-email",
      }),
    ).rejects.toBeInstanceOf(ZodError);
  });

  it("rejects an empty name via ZodError", async () => {
    await expect(
      addCoachInternal(fixtures.admin, {
        name: "   ",
        email: uniqueEmail("emptyname"),
      }),
    ).rejects.toBeInstanceOf(ZodError);
  });
});
