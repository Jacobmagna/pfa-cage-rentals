// Integration tests for src/lib/server/rate-override-actions.ts.
// Same direct-internal pattern as session-actions.test.ts. The public
// "use server" wrappers in src/app/admin/coaches/[id]/actions.ts add
// only requireRole("admin") (covered in admin-actions-authz.test.ts)
// and revalidatePath.
//
// Critical regression test: rate snapshots on session rows are
// IMMUTABLE under override changes. Locking that rule into CI is the
// reason this file exists — Batch 1 of the audit just shipped the fix
// that made it true on all admin surfaces.

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  auditLog,
  coachRateOverrides,
  rateDefaults,
  sessionsBilling,
  users,
} from "@/db/schema";
import {
  deleteRateOverrideInternal,
  upsertRateOverrideInternal,
} from "@/lib/server/rate-override-actions";
import {
  createSessionInternal,
  resolveRateCents,
} from "@/lib/server/session-actions";
import { RateOverrideNotFoundError } from "@/lib/errors";
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
  return `ro-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.invalid`;
}

async function createThrowawayCoach(name = "Override Test Coach") {
  const [row] = await db
    .insert(users)
    .values({ email: uniqueEmail("coach"), name, role: "coach" })
    .returning();
  return row;
}

function tomorrowAt(hour: number, minute = 0): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(hour, minute, 0, 0);
  return d;
}

describe("upsertRateOverrideInternal", () => {
  it("creates a new override row and writes a create audit entry", async () => {
    const coach = await createThrowawayCoach();
    const row = await upsertRateOverrideInternal(fixtures.admin, {
      coachId: coach.id,
      resourceType: "cage",
      ratePer30MinCents: 1700,
    });
    expect(row.coachId).toBe(coach.id);
    expect(row.resourceType).toBe("cage");
    expect(row.ratePer30MinCents).toBe(1700);

    const [persisted] = await db
      .select()
      .from(coachRateOverrides)
      .where(
        and(
          eq(coachRateOverrides.coachId, coach.id),
          eq(coachRateOverrides.resourceType, "cage"),
        ),
      );
    expect(persisted).toBeDefined();
    expect(persisted.ratePer30MinCents).toBe(1700);

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "rate_override"),
          eq(auditLog.entityId, `${coach.id}:cage`),
          eq(auditLog.action, "create"),
        ),
      );
    expect(audit).toBeDefined();
    expect(audit.actorUserId).toBe(fixtures.admin.id);
    const diff = audit.diff as { after: Record<string, unknown> };
    expect(diff.after.ratePer30MinCents).toBe(1700);
  });

  it("updates an existing override and logs an update with shallow before/after diff", async () => {
    const coach = await createThrowawayCoach();
    await upsertRateOverrideInternal(fixtures.admin, {
      coachId: coach.id,
      resourceType: "cage",
      ratePer30MinCents: 1700,
    });
    await upsertRateOverrideInternal(fixtures.admin, {
      coachId: coach.id,
      resourceType: "cage",
      ratePer30MinCents: 1500,
    });

    const [persisted] = await db
      .select()
      .from(coachRateOverrides)
      .where(
        and(
          eq(coachRateOverrides.coachId, coach.id),
          eq(coachRateOverrides.resourceType, "cage"),
        ),
      );
    expect(persisted.ratePer30MinCents).toBe(1500);

    const updates = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "rate_override"),
          eq(auditLog.entityId, `${coach.id}:cage`),
          eq(auditLog.action, "update"),
        ),
      );
    expect(updates).toHaveLength(1);
    const diff = updates[0].diff as {
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    };
    expect(diff.before.ratePer30MinCents).toBe(1700);
    expect(diff.after.ratePer30MinCents).toBe(1500);
  });

  it("does NOT retroactively change rates on sessions already logged", async () => {
    // The snapshot rule, locked in by CI. Batch 1 of the audit shipped
    // the fix; this test stops a future refactor from regressing it.
    const coach = await createThrowawayCoach();

    await upsertRateOverrideInternal(fixtures.admin, {
      coachId: coach.id,
      resourceType: "cage",
      ratePer30MinCents: 1700,
    });

    const session = await createSessionInternal(fixtures.admin, {
      coachId: coach.id,
      resourceId: seeded.cage1.id,
      startAt: tomorrowAt(10),
      endAt: tomorrowAt(11),
    });
    expect(session.ratePer30MinCents).toBe(1700);

    // Renegotiate to a brand-new rate.
    await upsertRateOverrideInternal(fixtures.admin, {
      coachId: coach.id,
      resourceType: "cage",
      ratePer30MinCents: 2500,
    });

    const [persistedSession] = await db
      .select()
      .from(sessionsBilling)
      .where(eq(sessionsBilling.id, session.id));
    expect(persistedSession.ratePer30MinCents).toBe(1700);
  });

  it("future sessions pick up the new override, past sessions keep the old one", async () => {
    const coach = await createThrowawayCoach();

    await upsertRateOverrideInternal(fixtures.admin, {
      coachId: coach.id,
      resourceType: "cage",
      ratePer30MinCents: 1700,
    });
    const past = await createSessionInternal(fixtures.admin, {
      coachId: coach.id,
      resourceId: seeded.cage1.id,
      startAt: tomorrowAt(10),
      endAt: tomorrowAt(11),
    });

    await upsertRateOverrideInternal(fixtures.admin, {
      coachId: coach.id,
      resourceType: "cage",
      ratePer30MinCents: 2500,
    });
    const future = await createSessionInternal(fixtures.admin, {
      coachId: coach.id,
      resourceId: seeded.cage1.id,
      startAt: tomorrowAt(13),
      endAt: tomorrowAt(14),
    });

    expect(past.ratePer30MinCents).toBe(1700);
    expect(future.ratePer30MinCents).toBe(2500);
  });

  it("rejects non-integer or out-of-range cents", async () => {
    const coach = await createThrowawayCoach();
    await expect(
      upsertRateOverrideInternal(fixtures.admin, {
        coachId: coach.id,
        resourceType: "cage",
        ratePer30MinCents: 0,
      }),
    ).rejects.toThrow();
    await expect(
      upsertRateOverrideInternal(fixtures.admin, {
        coachId: coach.id,
        resourceType: "cage",
        ratePer30MinCents: -100,
      }),
    ).rejects.toThrow();
    await expect(
      upsertRateOverrideInternal(fixtures.admin, {
        coachId: coach.id,
        resourceType: "cage",
        ratePer30MinCents: 17.5,
      }),
    ).rejects.toThrow();
    await expect(
      upsertRateOverrideInternal(fixtures.admin, {
        coachId: coach.id,
        resourceType: "cage",
        ratePer30MinCents: 1_000_000,
      }),
    ).rejects.toThrow();
  });

  it("rejects unsupported resourceType values", async () => {
    const coach = await createThrowawayCoach();
    await expect(
      upsertRateOverrideInternal(fixtures.admin, {
        coachId: coach.id,
        resourceType: "yoga_room",
        ratePer30MinCents: 1500,
      }),
    ).rejects.toThrow();
  });

  // GROUP-RATE (4th tier): the optional per-coach group weight-room override
  // persists into the new column and is READ BACK by resolveRateCents when a
  // group weight-room session is resolved.
  it("persists a groupRatePer30MinCents on a weight_room override and resolves it for a group session", async () => {
    const coach = await createThrowawayCoach();

    const row = await upsertRateOverrideInternal(fixtures.admin, {
      coachId: coach.id,
      resourceType: "weight_room",
      ratePer30MinCents: 800,
      groupRatePer30MinCents: 1600,
    });
    expect(row.groupRatePer30MinCents).toBe(1600);

    const [persisted] = await db
      .select()
      .from(coachRateOverrides)
      .where(
        and(
          eq(coachRateOverrides.coachId, coach.id),
          eq(coachRateOverrides.resourceType, "weight_room"),
        ),
      );
    expect(persisted.ratePer30MinCents).toBe(800);
    expect(persisted.groupRatePer30MinCents).toBe(1600);

    // Read back through resolution: a group weight-room session resolves the
    // coach's group override...
    const groupRate = await resolveRateCents({
      coachId: coach.id,
      resourceType: "weight_room",
      isGroupSession: true,
    });
    expect(groupRate).toBe(1600);

    // ...while a NON-group weight-room session resolves the regular override.
    const regularRate = await resolveRateCents({
      coachId: coach.id,
      resourceType: "weight_room",
      isGroupSession: false,
    });
    expect(regularRate).toBe(800);
  });

  it("rejects a groupRatePer30MinCents on a non-weight_room override", async () => {
    const coach = await createThrowawayCoach();
    await expect(
      upsertRateOverrideInternal(fixtures.admin, {
        coachId: coach.id,
        resourceType: "cage",
        ratePer30MinCents: 1700,
        groupRatePer30MinCents: 1500,
      }),
    ).rejects.toThrow();
  });

  it("leaves an existing group override intact when a later upsert omits it", async () => {
    const coach = await createThrowawayCoach();
    await upsertRateOverrideInternal(fixtures.admin, {
      coachId: coach.id,
      resourceType: "weight_room",
      ratePer30MinCents: 800,
      groupRatePer30MinCents: 1600,
    });

    // Update only the regular rate; group rate omitted must NOT clobber.
    const updated = await upsertRateOverrideInternal(fixtures.admin, {
      coachId: coach.id,
      resourceType: "weight_room",
      ratePer30MinCents: 900,
    });
    expect(updated.ratePer30MinCents).toBe(900);
    expect(updated.groupRatePer30MinCents).toBe(1600);
  });

  it("CLEARS an existing group override when a later upsert passes null, leaving the regular rate override intact", async () => {
    const coach = await createThrowawayCoach();
    await upsertRateOverrideInternal(fixtures.admin, {
      coachId: coach.id,
      resourceType: "weight_room",
      ratePer30MinCents: 800,
      groupRatePer30MinCents: 1600,
    });

    // The rate card's blank group input sends an explicit null → CLEAR the
    // group override while preserving the regular weight-room rate override.
    const cleared = await upsertRateOverrideInternal(fixtures.admin, {
      coachId: coach.id,
      resourceType: "weight_room",
      ratePer30MinCents: 800,
      groupRatePer30MinCents: null,
    });
    expect(cleared.ratePer30MinCents).toBe(800);
    expect(cleared.groupRatePer30MinCents).toBeNull();

    const [persisted] = await db
      .select()
      .from(coachRateOverrides)
      .where(
        and(
          eq(coachRateOverrides.coachId, coach.id),
          eq(coachRateOverrides.resourceType, "weight_room"),
        ),
      );
    // Group column NULL (cleared)...
    expect(persisted.groupRatePer30MinCents).toBeNull();
    // ...and the regular override untouched (NOT deleted).
    expect(persisted.ratePer30MinCents).toBe(800);

    // With the coach group override cleared AND no facility group default,
    // a group booking falls all the way back to the regular weight-room rate.
    // Control the facility default explicitly so this doesn't depend on ambient
    // rate_defaults state (which survives truncation).
    const [wrDefault] = await db
      .select()
      .from(rateDefaults)
      .where(eq(rateDefaults.type, "weight_room"));
    const origGroupDefault = wrDefault?.groupRatePer30MinCents ?? null;
    await db
      .update(rateDefaults)
      .set({ groupRatePer30MinCents: null })
      .where(eq(rateDefaults.type, "weight_room"));
    try {
      const groupRate = await resolveRateCents({
        coachId: coach.id,
        resourceType: "weight_room",
        isGroupSession: true,
      });
      expect(groupRate).toBe(800);
    } finally {
      await db
        .update(rateDefaults)
        .set({ groupRatePer30MinCents: origGroupDefault })
        .where(eq(rateDefaults.type, "weight_room"));
    }
  });

  it("PRESERVES an existing group override when a later upsert omits it (undefined)", async () => {
    const coach = await createThrowawayCoach();
    await upsertRateOverrideInternal(fixtures.admin, {
      coachId: coach.id,
      resourceType: "weight_room",
      ratePer30MinCents: 800,
      groupRatePer30MinCents: 1600,
    });

    // Field OMITTED entirely (undefined) → the protective preserve behavior
    // still holds for callers that don't include the group field.
    const updated = await upsertRateOverrideInternal(fixtures.admin, {
      coachId: coach.id,
      resourceType: "weight_room",
      ratePer30MinCents: 950,
    });
    expect(updated.ratePer30MinCents).toBe(950);
    expect(updated.groupRatePer30MinCents).toBe(1600);

    const [persisted] = await db
      .select()
      .from(coachRateOverrides)
      .where(
        and(
          eq(coachRateOverrides.coachId, coach.id),
          eq(coachRateOverrides.resourceType, "weight_room"),
        ),
      );
    expect(persisted.groupRatePer30MinCents).toBe(1600);
  });

  it("accepts null groupRatePer30MinCents on a non-weight_room type (a clear is valid for any type)", async () => {
    const coach = await createThrowawayCoach();
    // null is NOT a group value being set on a cage — it's a no-op clear, so
    // the superRefine must NOT reject it. (A non-null value still would.)
    const row = await upsertRateOverrideInternal(fixtures.admin, {
      coachId: coach.id,
      resourceType: "cage",
      ratePer30MinCents: 1700,
      groupRatePer30MinCents: null,
    });
    expect(row.ratePer30MinCents).toBe(1700);
    expect(row.groupRatePer30MinCents).toBeNull();
  });
});

describe("deleteRateOverrideInternal", () => {
  it("removes the row and logs a delete with the pre-state snapshot", async () => {
    const coach = await createThrowawayCoach();
    await upsertRateOverrideInternal(fixtures.admin, {
      coachId: coach.id,
      resourceType: "cage",
      ratePer30MinCents: 1700,
    });

    await deleteRateOverrideInternal(fixtures.admin, {
      coachId: coach.id,
      resourceType: "cage",
    });

    const remaining = await db
      .select()
      .from(coachRateOverrides)
      .where(
        and(
          eq(coachRateOverrides.coachId, coach.id),
          eq(coachRateOverrides.resourceType, "cage"),
        ),
      );
    expect(remaining).toHaveLength(0);

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "rate_override"),
          eq(auditLog.entityId, `${coach.id}:cage`),
          eq(auditLog.action, "delete"),
        ),
      );
    expect(audit).toBeDefined();
    const diff = audit.diff as { before: Record<string, unknown> };
    expect(diff.before.ratePer30MinCents).toBe(1700);
  });

  it("future sessions fall back to default after override deleted", async () => {
    const coach = await createThrowawayCoach();
    await upsertRateOverrideInternal(fixtures.admin, {
      coachId: coach.id,
      resourceType: "cage",
      ratePer30MinCents: 1700,
    });

    await deleteRateOverrideInternal(fixtures.admin, {
      coachId: coach.id,
      resourceType: "cage",
    });

    const session = await createSessionInternal(fixtures.admin, {
      coachId: coach.id,
      resourceId: seeded.cage1.id,
      startAt: tomorrowAt(10),
      endAt: tomorrowAt(11),
    });
    // Default cage rate is 2200 (DEFAULT_RATES_PER_SLOT_CENTS in
    // billing.ts; seeded into rate_defaults). Asserting against the
    // seeded value to catch any future drift between billing.ts and
    // the seed.
    expect(session.ratePer30MinCents).toBe(2200);
  });

  it("rejects deleting an override that does not exist", async () => {
    const coach = await createThrowawayCoach();
    await expect(
      deleteRateOverrideInternal(fixtures.admin, {
        coachId: coach.id,
        resourceType: "cage",
      }),
    ).rejects.toBeInstanceOf(RateOverrideNotFoundError);
  });
});
