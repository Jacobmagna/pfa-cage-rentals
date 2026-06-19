// Integration tests for the internal session mutation logic.
// These hit a real Neon dev branch — see vitest.integration.config.ts
// and tests/integration/setup.ts for env wiring.
//
// We call the INTERNAL functions (src/lib/server/session-actions.ts)
// directly with a synthetic actor instead of going through the public
// "use server" wrappers in src/app/admin/sessions/actions.ts. The
// wrappers add a single line — requireRole("admin") — which is covered
// separately in admin-actions-authz.test.ts via mocked auth(). Calling
// internals here lets every other test run without mocking framework
// internals.

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  auditLog,
  coachRateOverrides,
  sessionsBilling,
  blockedTimes,
} from "@/db/schema";
import {
  createSessionInternal,
  createSessionsBatchInternal,
  deleteSessionInternal,
  updateSessionInternal,
} from "@/lib/server/session-actions";
import {
  BlockedTimeError,
  SessionOverlapError,
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

// Tomorrow 10:00–11:00 UTC. Far enough out that overlapping with any
// real fixture is impossible; specific times are arbitrary because
// TRUNCATE runs between tests.
function tomorrowAt(hour: number, minute = 0): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(hour, minute, 0, 0);
  return d;
}

describe("createSessionInternal", () => {
  it("creates a session and writes a matching audit row", async () => {
    const startAt = tomorrowAt(10);
    const endAt = tomorrowAt(11);

    const created = await createSessionInternal(fixtures.admin, {
      coachId: fixtures.coach.id,
      resourceId: seeded.cage1.id,
      startAt,
      endAt,
      note: "happy path",
    });

    expect(created.id).toBeTruthy();
    expect(created.coachId).toBe(fixtures.coach.id);

    const audit = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.entityId, created.id), eq(auditLog.action, "create")),
      );
    expect(audit).toHaveLength(1);
    expect(audit[0].actorUserId).toBe(fixtures.admin.id);
    expect(audit[0].entityType).toBe("session");
  });

  it("rejects an overlapping window with SessionOverlapError naming the conflicting coach", async () => {
    await createSessionInternal(fixtures.admin, {
      coachId: fixtures.coach.id,
      resourceId: seeded.cage1.id,
      startAt: tomorrowAt(10),
      endAt: tomorrowAt(11),
    });

    const promise = createSessionInternal(fixtures.admin, {
      coachId: fixtures.coach.id,
      resourceId: seeded.cage1.id,
      startAt: tomorrowAt(10, 30),
      endAt: tomorrowAt(11, 30),
    });

    await expect(promise).rejects.toBeInstanceOf(SessionOverlapError);
    try {
      await promise;
    } catch (err) {
      expect(err).toBeInstanceOf(SessionOverlapError);
      const e = err as SessionOverlapError;
      expect(e.resourceName).toBe(seeded.cage1.name);
      expect(e.conflictingCoachName).toBe(fixtures.coach.name);
    }

    // Only one session landed.
    const rows = await db.select().from(sessionsBilling);
    expect(rows).toHaveLength(1);
  });

  it("rejects when a blocked time covers the requested window", async () => {
    await db.insert(blockedTimes).values({
      resourceId: seeded.cage1.id,
      startAt: tomorrowAt(9),
      endAt: tomorrowAt(12),
      reason: "HVAC repair",
      createdBy: fixtures.admin.id,
    });

    const promise = createSessionInternal(fixtures.admin, {
      coachId: fixtures.coach.id,
      resourceId: seeded.cage1.id,
      startAt: tomorrowAt(10),
      endAt: tomorrowAt(11),
    });

    await expect(promise).rejects.toBeInstanceOf(BlockedTimeError);
    try {
      await promise;
    } catch (err) {
      const e = err as BlockedTimeError;
      expect(e.resourceName).toBe(seeded.cage1.name);
      expect(e.blockReason).toBe("HVAC repair");
    }

    const sessions = await db.select().from(sessionsBilling);
    expect(sessions).toHaveLength(0);
  });
});

describe("updateSessionInternal", () => {
  it("writes a changed-keys-only diff to audit_log", async () => {
    const created = await createSessionInternal(fixtures.admin, {
      coachId: fixtures.coach.id,
      resourceId: seeded.cage1.id,
      startAt: tomorrowAt(10),
      endAt: tomorrowAt(11),
      note: "before",
    });

    await updateSessionInternal(fixtures.admin, created.id, {
      note: "after",
    });

    const updateRows = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.entityId, created.id), eq(auditLog.action, "update")),
      );
    expect(updateRows).toHaveLength(1);
    const diff = updateRows[0].diff as {
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    };

    // Only changed keys present in the diff (shallowDiff contract).
    // updatedAt also moves on every write, so it'll be in the diff too;
    // we just assert the keys we changed are present with correct values.
    expect(diff.before.note).toBe("before");
    expect(diff.after.note).toBe("after");

    // Unchanged keys must NOT appear in the diff.
    expect(diff.before).not.toHaveProperty("coachId");
    expect(diff.before).not.toHaveProperty("resourceId");
    expect(diff.before).not.toHaveProperty("startAt");
  });
});

describe("deleteSessionInternal", () => {
  it("removes the session row and writes a delete audit row with the before snapshot", async () => {
    const created = await createSessionInternal(fixtures.admin, {
      coachId: fixtures.coach.id,
      resourceId: seeded.bullpen1.id,
      startAt: tomorrowAt(14),
      endAt: tomorrowAt(15),
    });

    await deleteSessionInternal(fixtures.admin, created.id);

    const remaining = await db
      .select()
      .from(sessionsBilling)
      .where(eq(sessionsBilling.id, created.id));
    expect(remaining).toHaveLength(0);

    const deleteAudit = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.entityId, created.id), eq(auditLog.action, "delete")),
      );
    expect(deleteAudit).toHaveLength(1);
    const diff = deleteAudit[0].diff as { before: Record<string, unknown> };
    expect(diff.before).toBeTruthy();
    expect(diff.before.id).toBe(created.id);
    expect(diff.before.coachId).toBe(fixtures.coach.id);
  });
});

describe("createSessionsBatchInternal multi-resource", () => {
  it("inserts rows across cage1 + cage2 (per-slot resourceId) and writes one batch audit row", async () => {
    const inserted = await createSessionsBatchInternal(fixtures.admin, {
      coachId: fixtures.coach.id,
      // No top-level resourceId — each slot carries its own.
      slots: [
        {
          resourceId: seeded.cage1.id,
          startAt: tomorrowAt(10),
          endAt: tomorrowAt(10, 30),
        },
        {
          resourceId: seeded.cage2.id,
          startAt: tomorrowAt(10),
          endAt: tomorrowAt(10, 30),
        },
      ],
    });

    expect(inserted).toHaveLength(2);
    const byResource = new Map(inserted.map((r) => [r.resourceId, r]));
    expect(byResource.has(seeded.cage1.id)).toBe(true);
    expect(byResource.has(seeded.cage2.id)).toBe(true);

    const rows = await db.select().from(sessionsBilling);
    expect(rows).toHaveLength(2);

    // Exactly one batch audit row, keyed to the first inserted id.
    const audit = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityId, inserted[0].id),
          eq(auditLog.action, "create"),
        ),
      );
    expect(audit).toHaveLength(1);
    const after = (audit[0].diff as { after: Record<string, unknown> }).after;
    expect(after.batch).toBe(true);
    expect(after.count).toBe(2);
    expect(after.resourceIds).toEqual(
      expect.arrayContaining([seeded.cage1.id, seeded.cage2.id]),
    );
    const auditRows = after.rows as Array<{
      sessionId: string;
      resourceId: string;
    }>;
    expect(auditRows).toHaveLength(2);
  });

  it("bills each row at ITS resource type's rate (cage rate != bullpen rate)", async () => {
    // Make cage cost differ from bullpen for this coach: override the
    // coach's cage rate to 1700 (seeded bullpen default is 2200). Cleared
    // by truncateMutables before the next test.
    await db.insert(coachRateOverrides).values({
      coachId: fixtures.coach.id,
      resourceType: "cage",
      ratePer30MinCents: 1700,
    });

    const inserted = await createSessionsBatchInternal(fixtures.admin, {
      coachId: fixtures.coach.id,
      slots: [
        {
          resourceId: seeded.cage1.id,
          startAt: tomorrowAt(10),
          endAt: tomorrowAt(10, 30),
        },
        {
          resourceId: seeded.bullpen1.id,
          startAt: tomorrowAt(10),
          endAt: tomorrowAt(10, 30),
        },
      ],
    });

    const cageRow = inserted.find((r) => r.resourceId === seeded.cage1.id);
    const bullpenRow = inserted.find(
      (r) => r.resourceId === seeded.bullpen1.id,
    );
    // Headline money assertion: each row stamped with its own type's rate.
    expect(cageRow?.ratePer30MinCents).toBe(1700);
    expect(bullpenRow?.ratePer30MinCents).toBe(2200);
  });

  it("per-resource overlap rejects the conflicting cage and inserts NOTHING (all-or-nothing)", async () => {
    // Pre-existing session on cage1.
    await createSessionInternal(fixtures.admin, {
      coachId: fixtures.coach.id,
      resourceId: seeded.cage1.id,
      startAt: tomorrowAt(10),
      endAt: tomorrowAt(11),
    });

    const promise = createSessionsBatchInternal(fixtures.admin, {
      coachId: fixtures.coach.id,
      slots: [
        // Collides with the existing cage1 session.
        {
          resourceId: seeded.cage1.id,
          startAt: tomorrowAt(10, 30),
          endAt: tomorrowAt(11),
        },
        // Free cage2 slot.
        {
          resourceId: seeded.cage2.id,
          startAt: tomorrowAt(10, 30),
          endAt: tomorrowAt(11),
        },
      ],
    });

    await expect(promise).rejects.toBeInstanceOf(SessionOverlapError);

    // The pre-existing cage1 row is the ONLY row — nothing from the batch
    // landed (the free cage2 slot must not have been inserted).
    const rows = await db.select().from(sessionsBilling);
    expect(rows).toHaveLength(1);
    expect(rows[0].resourceId).toBe(seeded.cage1.id);
  });

  it("does NOT self-reject cross-cage slots at the same time", async () => {
    const inserted = await createSessionsBatchInternal(fixtures.admin, {
      coachId: fixtures.coach.id,
      slots: [
        {
          resourceId: seeded.cage1.id,
          startAt: tomorrowAt(10),
          endAt: tomorrowAt(10, 30),
        },
        {
          resourceId: seeded.cage2.id,
          startAt: tomorrowAt(10),
          endAt: tomorrowAt(10, 30),
        },
      ],
    });
    expect(inserted).toHaveLength(2);

    const rows = await db.select().from(sessionsBilling);
    expect(rows).toHaveLength(2);
  });

  it("still rejects same-cage intra-batch overlap (zero rows)", async () => {
    const promise = createSessionsBatchInternal(fixtures.admin, {
      coachId: fixtures.coach.id,
      slots: [
        {
          resourceId: seeded.cage1.id,
          startAt: tomorrowAt(10),
          endAt: tomorrowAt(11),
        },
        // Overlaps the first slot on the SAME cage.
        {
          resourceId: seeded.cage1.id,
          startAt: tomorrowAt(10, 30),
          endAt: tomorrowAt(11, 30),
        },
      ],
    });

    await expect(promise).rejects.toBeInstanceOf(SessionOverlapError);

    const rows = await db.select().from(sessionsBilling);
    expect(rows).toHaveLength(0);
  });

  it("rejects the batch when a block covers one slot's cage (zero rows)", async () => {
    await db.insert(blockedTimes).values({
      resourceId: seeded.cage2.id,
      startAt: tomorrowAt(9),
      endAt: tomorrowAt(12),
      reason: "Floor refinishing",
      createdBy: fixtures.admin.id,
    });

    const promise = createSessionsBatchInternal(fixtures.admin, {
      coachId: fixtures.coach.id,
      slots: [
        {
          resourceId: seeded.cage1.id,
          startAt: tomorrowAt(10),
          endAt: tomorrowAt(10, 30),
        },
        // Lands inside the cage2 block.
        {
          resourceId: seeded.cage2.id,
          startAt: tomorrowAt(10),
          endAt: tomorrowAt(10, 30),
        },
      ],
    });

    await expect(promise).rejects.toBeInstanceOf(BlockedTimeError);
    try {
      await promise;
    } catch (err) {
      const e = err as BlockedTimeError;
      expect(e.resourceName).toBe(seeded.cage2.name);
      expect(e.blockReason).toBe("Floor refinishing");
    }

    const rows = await db.select().from(sessionsBilling);
    expect(rows).toHaveLength(0);
  });

  it("back-compat: top-level resourceId with no per-slot resourceId still works", async () => {
    const inserted = await createSessionsBatchInternal(fixtures.admin, {
      coachId: fixtures.coach.id,
      resourceId: seeded.cage1.id,
      slots: [
        { startAt: tomorrowAt(10), endAt: tomorrowAt(10, 30) },
        { startAt: tomorrowAt(10, 30), endAt: tomorrowAt(11) },
      ],
    });

    expect(inserted).toHaveLength(2);
    expect(inserted.every((r) => r.resourceId === seeded.cage1.id)).toBe(true);

    const rows = await db.select().from(sessionsBilling);
    expect(rows).toHaveLength(2);
  });
});
