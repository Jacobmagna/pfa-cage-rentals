// Integration proof for src/db/clear-legacy-coaches.ts against the Neon
// DEV branch (via INTEGRATION_DATABASE_URL — see setup.ts).
//
// Deliberately does NOT depend on build/seed-data/coaches.json (PII,
// gitignored). It builds an in-test FIXTURE with a unique email suffix
// per run so the rows are isolated + trivially cleanable, and an in-test
// keep-set built from the same suffix.
//
// What it proves:
//   1. findLegacyCoaches returns EXACTLY the active legacy coaches — not
//      the admin, not the keep-set coaches, not an already-soft-deleted
//      legacy coach.
//   2. softDeleteLegacyCoaches soft-deletes exactly those targets; the
//      keep-set coaches + the admin keep deletedAt IS NULL.
//   3. Idempotency: a second run returns softDeleted: 0.
//   4. An empty keep-set THROWS and writes nothing.
//
// Cleanup: delete exactly the rows this suite created (every fixture
// email ends with the unique SUFFIX) in afterAll.

import { afterAll, describe, expect, it } from "vitest";
import { and, eq, isNull, like } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import {
  findLegacyCoaches,
  softDeleteLegacyCoaches,
} from "@/db/clear-legacy-coaches";

const describeIf = process.env.INTEGRATION_DATABASE_URL
  ? describe
  : describe.skip;

// Unique per run. Appended to every fixture email (before the domain) so
// our rows are isolated from any other user data on the branch and
// trivially cleanable via a LIKE on the local-part suffix.
const SUFFIX = `legacytest_${Date.now()}_${Math.random()
  .toString(36)
  .slice(2, 8)}`;
const DOMAIN = "pfa-legacytest.invalid";

// Keep-set coaches (role coach, emails ARE in the keep-set).
const KEEP_COACH_1 = `keepcoach1_${SUFFIX}@${DOMAIN}`;
const KEEP_COACH_2 = `keepcoach2_${SUFFIX}@${DOMAIN}`;
// Legacy coaches (role coach, emails NOT in the keep-set) — the targets.
const LEGACY_COACH_1 = `legacy1_${SUFFIX}@${DOMAIN}`;
const LEGACY_COACH_2 = `legacy2_${SUFFIX}@${DOMAIN}`;
// Admin (role admin, email NOT in keep-set) — excluded by the role filter.
const ADMIN_EMAIL = `admin_${SUFFIX}@${DOMAIN}`;
// Already-soft-deleted legacy coach (deletedAt set) — excluded by the
// deletedAt IS NULL filter, and must NOT be re-counted.
const PREDELETED_LEGACY = `predeleted_${SUFFIX}@${DOMAIN}`;

// The keep-set passed to the functions: the two keep-coach emails,
// already lowercased (these are all-lowercase fixtures). Used to prove
// the keep-set coaches survive.
const KEEP_SET = new Set([KEEP_COACH_1, KEEP_COACH_2]);

const PREDELETED_AT = new Date("2020-01-01T00:00:00Z");

async function deletedAtFor(email: string): Promise<Date | null> {
  const [row] = await db
    .select({ deletedAt: users.deletedAt })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  return row?.deletedAt ?? null;
}

afterAll(async () => {
  // Every fixture email's local-part ends with the unique SUFFIX before
  // the "@", so a LIKE on `%SUFFIX@DOMAIN` scopes the delete to our rows.
  await db.delete(users).where(like(users.email, `%${SUFFIX}@${DOMAIN}`));
});

describeIf("clear-legacy-coaches (integration, dev branch)", () => {
  it("finds and soft-deletes only active legacy coaches, idempotently", async () => {
    // Seed the fixture graph. createdAt is left to default (now) for the
    // active rows; the pre-deleted row gets an explicit deletedAt.
    await db.insert(users).values([
      { email: KEEP_COACH_1, name: "Keep Coach 1", role: "coach" },
      { email: KEEP_COACH_2, name: "Keep Coach 2", role: "coach" },
      { email: LEGACY_COACH_1, name: "Legacy Coach 1", role: "coach" },
      { email: LEGACY_COACH_2, name: "Legacy Coach 2", role: "coach" },
      { email: ADMIN_EMAIL, name: "Legacy Admin", role: "admin" },
      {
        email: PREDELETED_LEGACY,
        name: "Predeleted Legacy",
        role: "coach",
        deletedAt: PREDELETED_AT,
      },
    ]);

    // --- (1) findLegacyCoaches returns EXACTLY the 2 active legacy coaches.
    const found = await findLegacyCoaches(db, KEEP_SET);
    const foundOurs = found.filter((t) => t.email.endsWith(`${SUFFIX}@${DOMAIN}`));
    const foundEmails = foundOurs.map((t) => t.email).sort();
    expect(foundEmails).toEqual([LEGACY_COACH_1, LEGACY_COACH_2].sort());
    // Not the admin, not the keep coaches, not the already-deleted one.
    expect(foundEmails).not.toContain(ADMIN_EMAIL);
    expect(foundEmails).not.toContain(KEEP_COACH_1);
    expect(foundEmails).not.toContain(KEEP_COACH_2);
    expect(foundEmails).not.toContain(PREDELETED_LEGACY);

    // --- (2) softDeleteLegacyCoaches soft-deletes exactly those 2.
    const before = Date.now();
    const result = await softDeleteLegacyCoaches(db, KEEP_SET);
    const ourTargets = result.targets.filter((t) =>
      t.email.endsWith(`${SUFFIX}@${DOMAIN}`),
    );
    expect(ourTargets.map((t) => t.email).sort()).toEqual(
      [LEGACY_COACH_1, LEGACY_COACH_2].sort(),
    );

    // The 2 targets now have deletedAt set (≈ now).
    for (const email of [LEGACY_COACH_1, LEGACY_COACH_2]) {
      const d = await deletedAtFor(email);
      expect(d, `deletedAt for ${email}`).not.toBeNull();
      expect(d!.getTime()).toBeGreaterThanOrEqual(before - 60_000);
    }

    // The keep-set coaches + admin still have deletedAt IS NULL.
    for (const email of [KEEP_COACH_1, KEEP_COACH_2, ADMIN_EMAIL]) {
      const d = await deletedAtFor(email);
      expect(d, `deletedAt for ${email}`).toBeNull();
    }

    // The pre-deleted legacy coach keeps its ORIGINAL deletedAt (untouched).
    const preDeletedAt = await deletedAtFor(PREDELETED_LEGACY);
    expect(preDeletedAt?.getTime()).toBe(PREDELETED_AT.getTime());

    // --- (3) Idempotency: a second run finds/soft-deletes 0 of ours.
    const second = await softDeleteLegacyCoaches(db, KEEP_SET);
    const secondOurs = second.targets.filter((t) =>
      t.email.endsWith(`${SUFFIX}@${DOMAIN}`),
    );
    expect(secondOurs.length).toBe(0);

    // Sanity: zero of our active legacy coaches remain.
    const stillActiveLegacy = await db
      .select({ email: users.email })
      .from(users)
      .where(
        and(
          eq(users.role, "coach"),
          isNull(users.deletedAt),
          like(users.email, `%legacy%${SUFFIX}@${DOMAIN}`),
        ),
      );
    expect(stillActiveLegacy.length).toBe(0);
  });

  it("refuses an empty keep-set (throws) and writes nothing", async () => {
    // Seed a single active legacy coach with a DISTINCT local-part so we
    // can assert it survived. Shares the SUFFIX so afterAll cleans it up.
    const emptyTestEmail = `emptyset_${SUFFIX}@${DOMAIN}`;
    await db
      .insert(users)
      .values({ email: emptyTestEmail, name: "Empty Set Victim", role: "coach" });

    await expect(softDeleteLegacyCoaches(db, new Set())).rejects.toThrow(
      /empty keep-set/i,
    );

    // It must have written NOTHING: the row is still active.
    const survived = await deletedAtFor(emptyTestEmail);
    expect(survived).toBeNull();
  });
});
