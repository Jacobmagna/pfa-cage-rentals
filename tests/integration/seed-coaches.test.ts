// Integration proof for src/db/seed-coaches.ts against the Neon DEV
// branch (ep-dawn-forest, via INTEGRATION_DATABASE_URL — see setup.ts).
//
// Deliberately does NOT depend on build/seed-data/coaches.json (PII,
// gitignored). Instead it builds an in-test FIXTURE with a unique email
// suffix per run so the rows are isolated + trivially cleanable.
//
// What it proves:
//   (a) NEW emails are inserted as role "coach" with name + phone.
//   (b) An existing user seeded as role "admin" BEFORE the call keeps
//       role "admin" afterward — only name + phone are updated. This is
//       the role-preservation guarantee (so drc@pfasports.com is never
//       demoted by a reseed).
//   (c) A 2nd run inserts 0 (all emails now exist) and re-updates the
//       same rows — idempotent.
//
// Cleanup: delete exactly the rows this suite created (every fixture
// email ends with the unique SUFFIX) in afterAll.

import { afterAll, describe, expect, it } from "vitest";
import { eq, like, sql } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { seedCoaches, type CoachSeedInput } from "@/db/seed-coaches";

const describeIf = process.env.INTEGRATION_DATABASE_URL
  ? describe
  : describe.skip;

// Unique per run. Appended to every fixture email (before the domain) so
// our rows are isolated from any other user data on the branch and
// trivially cleanable via a LIKE on the local-part suffix.
const SUFFIX = `seedtest_${Date.now()}_${Math.random()
  .toString(36)
  .slice(2, 8)}`;
const DOMAIN = "pfa-coachtest.invalid";

const NEW_COACH_EMAIL = `newcoach_${SUFFIX}@${DOMAIN}`;
const EXISTING_ADMIN_EMAIL = `existingadmin_${SUFFIX}@${DOMAIN}`;

// A pre-existing admin whose email is stored MIXED-CASE. The local-part
// leads with mixed case ("MixedCase") but the unique `_${SUFFIX}@${DOMAIN}`
// tail stays lowercase so the afterAll LIKE still scopes the delete to our
// rows. The seed fixture uses the LOWERCASED form of this email.
const MIXED_CASE_STORED_EMAIL = `MixedCase_${SUFFIX}@${DOMAIN}`;
const MIXED_CASE_SEED_EMAIL = MIXED_CASE_STORED_EMAIL.toLowerCase();

const FIXTURE: CoachSeedInput[] = [
  { name: "New Coach", email: NEW_COACH_EMAIL, phone: "555-0100" },
  // This email is pre-seeded as an ADMIN below — seedCoaches must NOT
  // demote it.
  { name: "Existing Admin Updated", email: EXISTING_ADMIN_EMAIL, phone: "555-0200" },
];

afterAll(async () => {
  // Every fixture email's local-part ends with the unique SUFFIX before
  // the "@", so a LIKE on `%SUFFIX@DOMAIN` scopes the delete to our rows.
  await db.delete(users).where(like(users.email, `%${SUFFIX}@${DOMAIN}`));
});

describeIf("seedCoaches (integration, dev branch)", () => {
  it("inserts new coaches, preserves an existing admin's role, and is idempotent", async () => {
    // Pre-seed the "existing admin" with a DIFFERENT name + null phone so
    // we can prove the update touched name/phone but NOT role.
    await db.insert(users).values({
      email: EXISTING_ADMIN_EMAIL,
      name: "Original Admin Name",
      phone: null,
      role: "admin",
    });

    // --- first run --------------------------------------------------
    const first = await seedCoaches(db, FIXTURE);
    // One brand-new email (the coach) inserted; the admin already existed.
    expect(first.inserted).toBe(1);
    expect(first.updated).toBe(1);

    // (a) NEW email inserted as role "coach" with name + phone.
    const [newCoach] = await db
      .select({ name: users.name, role: users.role, phone: users.phone })
      .from(users)
      .where(eq(users.email, NEW_COACH_EMAIL))
      .limit(1);
    expect(newCoach.role).toBe("coach");
    expect(newCoach.name).toBe("New Coach");
    expect(newCoach.phone).toBe("555-0100");

    // (b) EXISTING admin keeps role "admin"; name + phone updated.
    const [admin] = await db
      .select({ name: users.name, role: users.role, phone: users.phone })
      .from(users)
      .where(eq(users.email, EXISTING_ADMIN_EMAIL))
      .limit(1);
    expect(admin.role).toBe("admin"); // role-preservation proof
    expect(admin.name).toBe("Existing Admin Updated");
    expect(admin.phone).toBe("555-0200");

    // --- second run: idempotent ------------------------------------
    const second = await seedCoaches(db, FIXTURE);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(2);

    // Still exactly 2 rows for our suffix; admin still admin.
    const ours = await db
      .select({ email: users.email, role: users.role })
      .from(users)
      .where(like(users.email, `%${SUFFIX}@${DOMAIN}`));
    expect(ours.length).toBe(2);
    const adminRow = ours.find((r) => r.email === EXISTING_ADMIN_EMAIL);
    expect(adminRow?.role).toBe("admin");
  });

  it("matches a pre-existing MIXED-CASE admin email case-insensitively (updates, no duplicate)", async () => {
    // Pre-seed an admin whose stored email is MIXED-CASE.
    await db.insert(users).values({
      email: MIXED_CASE_STORED_EMAIL,
      name: "Mixed Original Name",
      phone: null,
      role: "admin",
    });

    // Seed with the LOWERCASED form of that email.
    const fixture: CoachSeedInput[] = [
      {
        name: "Mixed Updated Name",
        email: MIXED_CASE_SEED_EMAIL,
        phone: "555-0300",
      },
    ];
    const res = await seedCoaches(db, fixture);
    // Existing row found case-insensitively → updated, not inserted.
    expect(res.inserted).toBe(0);
    expect(res.updated).toBe(1);

    // (a) NO duplicate: exactly one row matches case-insensitively.
    const matches = await db
      .select({ email: users.email, name: users.name, role: users.role, phone: users.phone })
      .from(users)
      .where(sql`lower(${users.email}) = ${MIXED_CASE_SEED_EMAIL}`);
    expect(matches.length).toBe(1);

    // (b) name + phone updated; (c) role still "admin"; original case kept.
    const [row] = matches;
    expect(row.email).toBe(MIXED_CASE_STORED_EMAIL);
    expect(row.name).toBe("Mixed Updated Name");
    expect(row.phone).toBe("555-0300");
    expect(row.role).toBe("admin");
  });
});
