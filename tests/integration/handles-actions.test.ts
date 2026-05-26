// Integration tests for src/lib/server/handles-actions.ts. Hits the
// real Neon dev branch. Same direct-internal pattern as the other
// suites — call the *Internal exports directly with a synthetic admin
// actor; public wrappers add only requireRole + revalidatePath.
//
// Out-of-scope notes:
//   - `users.venmoHandle` and `orgSettings.pfaVenmoHandle` columns are
//     documented as DORMANT (no UI consumer; kept on the chance Venmo
//     Business fee structure ever changes). We DO still test their
//     write path — the column exists, the action writes to it, and
//     audit log captures it. Removing the write path is a separate
//     decision per audit E16.
//   - User-level `name` updates live in src/app/actions.ts:updateOwnName,
//     not in this file — out of scope.
//
// Cleanup nuance: `orgSettings` is a singleton (id='default'), seeded
// once. To keep tests isolated, beforeAll snapshots the row and
// afterEach restores it.

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, orgSettings, users } from "@/db/schema";
import {
  getOrgSettings,
  updateOrgSettingsInternal,
  updateUserHandlesInternal,
} from "@/lib/server/handles-actions";
import { CoachNotFoundError } from "@/lib/errors";
import {
  ensureFixtureUsers,
  truncateMutables,
  type FixtureUsers,
} from "./fixtures";

let fixtures: FixtureUsers;
let orgSnapshot: typeof orgSettings.$inferSelect | null = null;

beforeAll(async () => {
  fixtures = await ensureFixtureUsers();
  const [row] = await db
    .select()
    .from(orgSettings)
    .where(eq(orgSettings.id, "default"))
    .limit(1);
  orgSnapshot = row ?? null;
});

beforeEach(async () => {
  await truncateMutables();
});

afterEach(async () => {
  // Restore orgSettings to the snapshot taken in beforeAll so tests
  // don't leak across the suite or onto whatever the dev branch had.
  if (orgSnapshot) {
    await db
      .insert(orgSettings)
      .values({
        id: "default",
        pfaVenmoHandle: orgSnapshot.pfaVenmoHandle,
        pfaZelleContact: orgSnapshot.pfaZelleContact,
        pfaDisplayName: orgSnapshot.pfaDisplayName,
        updatedBy: orgSnapshot.updatedBy,
      })
      .onConflictDoUpdate({
        target: orgSettings.id,
        set: {
          pfaVenmoHandle: orgSnapshot.pfaVenmoHandle,
          pfaZelleContact: orgSnapshot.pfaZelleContact,
          pfaDisplayName: orgSnapshot.pfaDisplayName,
          updatedBy: orgSnapshot.updatedBy,
        },
      });
  }
});

function uniqueEmail(label: string): string {
  return `handles-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.invalid`;
}

async function createThrowawayCoach(name = "Handles Test Coach") {
  const [row] = await db
    .insert(users)
    .values({ email: uniqueEmail("coach"), name, role: "coach" })
    .returning();
  return row;
}

describe("updateUserHandlesInternal", () => {
  it("sets the Zelle contact, returns the updated row, writes an audit row", async () => {
    const coach = await createThrowawayCoach();
    const updated = await updateUserHandlesInternal(fixtures.admin, {
      userId: coach.id,
      zelleContact: "coach@example.com",
    });
    expect(updated.zelleContact).toBe("coach@example.com");
    // venmoHandle was not in the input; it stays null.
    expect(updated.venmoHandle).toBeNull();

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "user_handles"),
          eq(auditLog.entityId, coach.id),
          eq(auditLog.action, "update"),
        ),
      );
    expect(audit).toBeDefined();
    const diff = audit.diff as {
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    };
    expect(diff.before.zelleContact).toBeNull();
    expect(diff.after.zelleContact).toBe("coach@example.com");
  });

  it("writes the Venmo handle even though the column is dormant (audit E16)", async () => {
    // The Venmo column has no UI consumer today, but the write path
    // still runs and the column is still written. This test exists so
    // a future "let's stop writing venmoHandle" change is a conscious
    // decision (delete this test) rather than an accidental regression.
    const coach = await createThrowawayCoach();
    const updated = await updateUserHandlesInternal(fixtures.admin, {
      userId: coach.id,
      venmoHandle: "DadVenmo",
    });
    // Schema lower-cases at the boundary.
    expect(updated.venmoHandle).toBe("dadvenmo");
  });

  it("normalizes Venmo input — strips leading @ and lower-cases", async () => {
    const coach = await createThrowawayCoach();
    const updated = await updateUserHandlesInternal(fixtures.admin, {
      userId: coach.id,
      venmoHandle: "@SomeCoach",
    });
    expect(updated.venmoHandle).toBe("somecoach");
  });

  it("treats empty Zelle/Venmo as 'clear the field' (writes NULL)", async () => {
    const coach = await createThrowawayCoach();
    await updateUserHandlesInternal(fixtures.admin, {
      userId: coach.id,
      zelleContact: "coach@example.com",
      venmoHandle: "coachpay",
    });
    const cleared = await updateUserHandlesInternal(fixtures.admin, {
      userId: coach.id,
      zelleContact: "",
      venmoHandle: "",
    });
    expect(cleared.zelleContact).toBeNull();
    expect(cleared.venmoHandle).toBeNull();
  });

  it("rejects an invalid Venmo handle (under 5 chars)", async () => {
    const coach = await createThrowawayCoach();
    await expect(
      updateUserHandlesInternal(fixtures.admin, {
        userId: coach.id,
        venmoHandle: "abc", // 3 chars, schema wants ≥5
      }),
    ).rejects.toThrow();
  });

  it("rejects a Zelle contact that's neither a phone nor an email", async () => {
    const coach = await createThrowawayCoach();
    await expect(
      updateUserHandlesInternal(fixtures.admin, {
        userId: coach.id,
        zelleContact: "not-an-email-or-phone",
      }),
    ).rejects.toThrow();
  });

  it("accepts a 10+ digit phone number as Zelle contact", async () => {
    const coach = await createThrowawayCoach();
    const updated = await updateUserHandlesInternal(fixtures.admin, {
      userId: coach.id,
      zelleContact: "(609) 555-1212",
    });
    expect(updated.zelleContact).toBe("(609) 555-1212");
  });

  it("rejects updates against a non-existent user id", async () => {
    await expect(
      updateUserHandlesInternal(fixtures.admin, {
        userId: "00000000-0000-0000-0000-000000000000",
        zelleContact: "foo@bar.com",
      }),
    ).rejects.toBeInstanceOf(CoachNotFoundError);
  });

  it("refuses to update a soft-deleted user (filters by isNull(deletedAt))", async () => {
    const coach = await createThrowawayCoach();
    await db
      .update(users)
      .set({ deletedAt: new Date() })
      .where(eq(users.id, coach.id));

    await expect(
      updateUserHandlesInternal(fixtures.admin, {
        userId: coach.id,
        zelleContact: "foo@bar.com",
      }),
    ).rejects.toBeInstanceOf(CoachNotFoundError);
  });
});

describe("updateOrgSettingsInternal", () => {
  it("updates pfaZelleContact and pfaDisplayName, returns the updated row + audit", async () => {
    const updated = await updateOrgSettingsInternal(fixtures.admin, {
      pfaZelleContact: "payments@pfasports.com",
      pfaDisplayName: "PFA Cage Rentals",
    });
    expect(updated.pfaZelleContact).toBe("payments@pfasports.com");
    expect(updated.pfaDisplayName).toBe("PFA Cage Rentals");
    expect(updated.updatedBy).toBe(fixtures.admin.id);

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "org_settings"),
          eq(auditLog.entityId, "default"),
          eq(auditLog.action, "update"),
        ),
      );
    expect(audit).toBeDefined();
    const diff = audit.diff as {
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    };
    expect(diff.after.pfaZelleContact).toBe("payments@pfasports.com");
    expect(diff.after.pfaDisplayName).toBe("PFA Cage Rentals");
  });

  it("writes pfaVenmoHandle even though it's dormant (audit E16)", async () => {
    // Same dormancy note as the user handles test: pfaVenmoHandle is
    // documented dormant but still written. This pins the contract so
    // a future cleanup is intentional.
    const updated = await updateOrgSettingsInternal(fixtures.admin, {
      pfaVenmoHandle: "pfasports",
    });
    expect(updated.pfaVenmoHandle).toBe("pfasports");
  });

  it("rejects an empty pfaDisplayName", async () => {
    await expect(
      updateOrgSettingsInternal(fixtures.admin, { pfaDisplayName: "  " }),
    ).rejects.toThrow();
  });

  it("getOrgSettings returns the (singleton) row that updateOrgSettingsInternal just wrote", async () => {
    await updateOrgSettingsInternal(fixtures.admin, {
      pfaDisplayName: "After Round-Trip",
    });
    const fetched = await getOrgSettings();
    expect(fetched.id).toBe("default");
    expect(fetched.pfaDisplayName).toBe("After Round-Trip");
  });
});
