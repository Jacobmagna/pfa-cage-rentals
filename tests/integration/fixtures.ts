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

export type FixtureUsers = {
  admin: User;
  coach: User;
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
      set: { role: "admin", name: "Integration Admin" },
    });

  await db
    .insert(users)
    .values({
      email: INTEGRATION_COACH_EMAIL,
      name: "Integration Coach",
      role: "coach",
    })
    .onConflictDoUpdate({
      target: users.email,
      set: { role: "coach", name: "Integration Coach" },
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

  if (!admin || !coach) {
    throw new Error("ensureFixtureUsers: upsert failed to round-trip");
  }
  return { admin, coach };
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
