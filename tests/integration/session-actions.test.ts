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
import { auditLog, sessionsBilling, blockedTimes } from "@/db/schema";
import {
  createSessionInternal,
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
