// Shared fixture helpers for integration tests. Assumes the
// integration Neon branch has already been migrated and seeded
// (`npm run db:migrate && npm run db:seed`) — both are idempotent
// so re-running is safe.
//
// Test isolation strategy: TRUNCATE the mutable tables in beforeEach.
// Seeded resources + rate defaults + the integration users below
// survive across tests. This is cheap because the dev branch is tiny
// and only this test suite writes to it.

import { sql } from "drizzle-orm";
import { db } from "@/db";
import { resources, users, type User } from "@/db/schema";
import { eq } from "drizzle-orm";

export const INTEGRATION_ADMIN_EMAIL = "integration-admin@pfa.invalid";
export const INTEGRATION_COACH_EMAIL = "integration-coach@pfa.invalid";
// A coach with the schedule_admin flag set — a "Schedule Manager". Used
// by the master-schedule authz/audit suites to prove the widened schedule
// actions accept this user while money/roster admin actions still reject.
export const INTEGRATION_FLAGGED_COACH_EMAIL = "flagged-coach@pfa.invalid";

export type FixtureUsers = {
  admin: User;
  coach: User;
  flaggedCoach: User;
};

// Upserts the two test users and returns them. Idempotent across runs.
// Roles are forced even if a previous test left them in a different
// state — guards against accidental cross-suite contamination.
export async function ensureFixtureUsers(): Promise<FixtureUsers> {
  await db
    .insert(users)
    .values({
      email: INTEGRATION_ADMIN_EMAIL,
      name: "Integration Admin",
      role: "admin",
    })
    .onConflictDoUpdate({
      target: users.email,
      // deletedAt: null un-soft-deletes a fixture a prior suite (e.g. the
      // J9 account-deletion / archive tests) may have left tombstoned —
      // active-coach surfaces filter isNull(deletedAt), so a stale
      // deletedAt makes the fixture invisible to the code under test.
      set: { role: "admin", name: "Integration Admin", deletedAt: null },
    });

  // Plain coach: role coach, scheduleAdmin explicitly false. Forcing the
  // flag off on every run guards against a previous suite leaving it on.
  await db
    .insert(users)
    .values({
      email: INTEGRATION_COACH_EMAIL,
      name: "Integration Coach",
      role: "coach",
      scheduleAdmin: false,
    })
    .onConflictDoUpdate({
      target: users.email,
      set: {
        role: "coach",
        name: "Integration Coach",
        scheduleAdmin: false,
        deletedAt: null,
      },
    });

  // Flagged coach ("Schedule Manager"): role coach, scheduleAdmin true.
  // Must be a real users row (schedule_admin=true) so the widened actions'
  // internal logic runs and the audit_log FK on actor_user_id resolves.
  await db
    .insert(users)
    .values({
      email: INTEGRATION_FLAGGED_COACH_EMAIL,
      name: "Integration Flagged Coach",
      role: "coach",
      scheduleAdmin: true,
    })
    .onConflictDoUpdate({
      target: users.email,
      set: {
        role: "coach",
        name: "Integration Flagged Coach",
        scheduleAdmin: true,
        deletedAt: null,
      },
    });

  const [admin] = await db
    .select()
    .from(users)
    .where(eq(users.email, INTEGRATION_ADMIN_EMAIL))
    .limit(1);
  const [coach] = await db
    .select()
    .from(users)
    .where(eq(users.email, INTEGRATION_COACH_EMAIL))
    .limit(1);
  const [flaggedCoach] = await db
    .select()
    .from(users)
    .where(eq(users.email, INTEGRATION_FLAGGED_COACH_EMAIL))
    .limit(1);

  if (!admin || !coach || !flaggedCoach) {
    throw new Error("ensureFixtureUsers: upsert failed to round-trip");
  }
  return { admin, coach, flaggedCoach };
}

// Returns the two cages and one bullpen the session tests need.
// Throws if seed data is missing — the test branch needs `npm run
// db:seed` to have been run at least once.
export async function getSeededResources() {
  const all = await db.select().from(resources);
  const cage1 = all.find((r) => r.name === "Cage 1");
  const cage2 = all.find((r) => r.name === "Cage 2");
  const bullpen1 = all.find((r) => r.name === "Bullpen 1");
  if (!cage1 || !cage2 || !bullpen1) {
    throw new Error(
      "Seeded resources not found on integration branch. Run " +
        "`INTEGRATION_DATABASE_URL=... npm run db:seed` against the " +
        "integration Neon branch first.",
    );
  }
  return { cage1, cage2, bullpen1 };
}

// Per-test cleanup. TRUNCATE every mutable test-relevant table in one
// statement; CASCADE handles audit_log rows that reference deleted
// session ids (not strictly needed since audit_log isn't an FK to
// sessions_billing, but harmless and future-proof if we ever add
// the FK back).
//
// `coach_payments` and `coach_rate_overrides` are included because the
// payment-actions and rate-override-actions test suites need a clean
// slate per test. `rate_defaults` is NOT truncated — it's seeded once
// per branch and the rate-defaults test suite snapshots/restores it
// inline (see rate-defaults-actions.test.ts).
export async function truncateMutables(): Promise<void> {
  await db.execute(
    sql`TRUNCATE TABLE sessions_billing, blocked_times, audit_log, coach_payments, coach_rate_overrides RESTART IDENTITY CASCADE`,
  );
}
