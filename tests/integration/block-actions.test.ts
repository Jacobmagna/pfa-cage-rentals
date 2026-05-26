// Integration tests for src/lib/server/block-actions.ts. Hits the real
// Neon dev branch. Same direct-internal pattern as the other suites —
// call the *Internal exports directly with a synthetic admin actor;
// the public "use server" wrappers add only requireRole + revalidatePath.
//
// Block invariants exercised here:
//   - block-vs-block overlap is enforced by the `blocked_times` EXCLUDE
//     constraint; the app catches SQLSTATE 23P01 and translates to
//     BlockOverlapError with the conflicting block's details
//   - block-vs-session overlap is enforced app-layer (Postgres EXCLUDE
//     can't span tables) and surfaces as BlockConflictsWithSessionError
//     with the conflicting coach's name (per project memory
//     `project_overlap_error_ux`).
//
// truncateMutables wipes blocked_times + sessions_billing + audit_log
// between tests, so each scenario starts clean.

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, blockedTimes, users } from "@/db/schema";
import {
  createBlockInternal,
  deleteBlockInternal,
  updateBlockInternal,
} from "@/lib/server/block-actions";
import { createSessionInternal } from "@/lib/server/session-actions";
import {
  BlockConflictsWithSessionError,
  BlockNotFoundError,
  BlockOverlapError,
  ResourceNotFoundError,
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
  return `block-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.invalid`;
}

async function createThrowawayCoach(name = "Block Test Coach") {
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

function baseCreateInput(resourceId: string, hour = 8) {
  return {
    resourceId,
    startAt: tomorrowAt(hour),
    endAt: tomorrowAt(hour + 1),
    reason: "HVAC maintenance",
  };
}

describe("createBlockInternal", () => {
  it("inserts a block row, returns it, and writes a matching audit row", async () => {
    const inserted = await createBlockInternal(
      fixtures.admin,
      baseCreateInput(seeded.cage1.id, 9),
    );

    expect(inserted.id).toBeTruthy();
    expect(inserted.resourceId).toBe(seeded.cage1.id);
    expect(inserted.reason).toBe("HVAC maintenance");
    expect(inserted.createdBy).toBe(fixtures.admin.id);
    expect(inserted.startAt).toBeInstanceOf(Date);
    expect(inserted.endAt).toBeInstanceOf(Date);

    const [row] = await db
      .select()
      .from(blockedTimes)
      .where(eq(blockedTimes.id, inserted.id));
    expect(row).toBeDefined();
    expect(row.reason).toBe("HVAC maintenance");

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "block"),
          eq(auditLog.entityId, inserted.id),
          eq(auditLog.action, "create"),
        ),
      );
    expect(audit).toBeDefined();
    expect(audit.actorUserId).toBe(fixtures.admin.id);
    const diff = audit.diff as { after: Record<string, unknown> };
    expect(diff.after.reason).toBe("HVAC maintenance");
    expect(diff.after.resourceId).toBe(seeded.cage1.id);
  });

  it("rejects a block whose resourceId does not exist", async () => {
    await expect(
      createBlockInternal(fixtures.admin, {
        resourceId: "00000000-0000-0000-0000-000000000000",
        startAt: tomorrowAt(8),
        endAt: tomorrowAt(9),
        reason: "Test",
      }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("rejects when reason is empty", async () => {
    await expect(
      createBlockInternal(fixtures.admin, {
        resourceId: seeded.cage1.id,
        startAt: tomorrowAt(8),
        endAt: tomorrowAt(9),
        reason: "",
      }),
    ).rejects.toThrow();
  });

  it("rejects when the time range is zero-length (startAt >= endAt)", async () => {
    // App layer: Zod accepts the dates as-is, but the DB CHECK
    // constraint (start_at < end_at) rejects. Either layer is fine —
    // what matters is the row never lands.
    const t = tomorrowAt(10);
    await expect(
      createBlockInternal(fixtures.admin, {
        resourceId: seeded.cage1.id,
        startAt: t,
        endAt: t,
        reason: "zero-length",
      }),
    ).rejects.toThrow();

    const rows = await db.select().from(blockedTimes);
    expect(rows).toHaveLength(0);
  });

  it("rejects a block that overlaps an existing block on the same resource (BlockOverlapError)", async () => {
    await createBlockInternal(fixtures.admin, {
      resourceId: seeded.cage1.id,
      startAt: tomorrowAt(10),
      endAt: tomorrowAt(12),
      reason: "Camp",
    });

    try {
      await createBlockInternal(fixtures.admin, {
        resourceId: seeded.cage1.id,
        startAt: tomorrowAt(11),
        endAt: tomorrowAt(13),
        reason: "Other camp",
      });
      throw new Error("expected BlockOverlapError to be thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BlockOverlapError);
      const e = err as BlockOverlapError;
      expect(e.resourceName).toBe(seeded.cage1.name);
      expect(e.conflictingReason).toBe("Camp");
    }
  });

  it("allows back-to-back blocks (end == next start; tsrange is half-open)", async () => {
    const first = await createBlockInternal(fixtures.admin, {
      resourceId: seeded.cage1.id,
      startAt: tomorrowAt(10),
      endAt: tomorrowAt(11),
      reason: "First",
    });
    const second = await createBlockInternal(fixtures.admin, {
      resourceId: seeded.cage1.id,
      startAt: tomorrowAt(11),
      endAt: tomorrowAt(12),
      reason: "Second",
    });
    expect(first.id).not.toBe(second.id);
  });

  it("rejects a block that overlaps an existing session (BlockConflictsWithSessionError carries coach name)", async () => {
    const coach = await createThrowawayCoach("Renee Booker");
    await createSessionInternal(fixtures.admin, {
      coachId: coach.id,
      resourceId: seeded.cage1.id,
      startAt: tomorrowAt(10),
      endAt: tomorrowAt(11),
      useType: "hitting",
    });

    try {
      await createBlockInternal(fixtures.admin, {
        resourceId: seeded.cage1.id,
        startAt: tomorrowAt(10, 30),
        endAt: tomorrowAt(12),
        reason: "Last-minute camp",
      });
      throw new Error("expected BlockConflictsWithSessionError to be thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BlockConflictsWithSessionError);
      // Project memory `project_overlap_error_ux`: the error must name
      // the conflicting coach so the admin can negotiate the slot.
      const e = err as BlockConflictsWithSessionError;
      expect(e.resourceName).toBe(seeded.cage1.name);
      expect(e.coachName).toBe("Renee Booker");
    }

    const rows = await db.select().from(blockedTimes);
    expect(rows).toHaveLength(0);
  });
});

describe("updateBlockInternal", () => {
  it("updates fields and emits a changed-keys-only audit diff", async () => {
    const created = await createBlockInternal(
      fixtures.admin,
      baseCreateInput(seeded.cage1.id, 9),
    );
    const updated = await updateBlockInternal(fixtures.admin, created.id, {
      reason: "Updated reason",
    });
    expect(updated.reason).toBe("Updated reason");

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "block"),
          eq(auditLog.entityId, created.id),
          eq(auditLog.action, "update"),
        ),
      );
    expect(audit).toBeDefined();
    const diff = audit.diff as {
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    };
    expect(diff.before.reason).toBe("HVAC maintenance");
    expect(diff.after.reason).toBe("Updated reason");
    expect("resourceId" in diff.before).toBe(false);
  });

  it("detects overlap when expanding an existing block into another block's range", async () => {
    await createBlockInternal(fixtures.admin, {
      resourceId: seeded.cage1.id,
      startAt: tomorrowAt(12),
      endAt: tomorrowAt(13),
      reason: "Lunch block",
    });
    const target = await createBlockInternal(fixtures.admin, {
      resourceId: seeded.cage1.id,
      startAt: tomorrowAt(10),
      endAt: tomorrowAt(11),
      reason: "Morning block",
    });

    await expect(
      updateBlockInternal(fixtures.admin, target.id, {
        endAt: tomorrowAt(12, 30),
      }),
    ).rejects.toBeInstanceOf(BlockOverlapError);
  });

  it("allows updating fields while keeping the block in its own (unchanged) range", async () => {
    // The exclude-self path: the DB constraint matches `target`'s old
    // range against the new range — without the excludeBlockId branch
    // we'd self-conflict. Pinning this to make sure the update doesn't
    // false-positive on its own footprint.
    const created = await createBlockInternal(
      fixtures.admin,
      baseCreateInput(seeded.cage1.id, 14),
    );
    const updated = await updateBlockInternal(fixtures.admin, created.id, {
      reason: "Just a label change",
    });
    expect(updated.reason).toBe("Just a label change");
  });

  it("rejects updating a block to overlap a session — BlockConflictsWithSessionError", async () => {
    const coach = await createThrowawayCoach("Cara Adjuster");
    await createSessionInternal(fixtures.admin, {
      coachId: coach.id,
      resourceId: seeded.cage1.id,
      startAt: tomorrowAt(15),
      endAt: tomorrowAt(16),
      useType: "pitching",
    });
    const block = await createBlockInternal(fixtures.admin, {
      resourceId: seeded.cage1.id,
      startAt: tomorrowAt(8),
      endAt: tomorrowAt(9),
      reason: "early-morning hold",
    });

    await expect(
      updateBlockInternal(fixtures.admin, block.id, {
        startAt: tomorrowAt(14, 30),
        endAt: tomorrowAt(15, 30),
      }),
    ).rejects.toBeInstanceOf(BlockConflictsWithSessionError);
  });

  it("rejects updating a non-existent block id", async () => {
    await expect(
      updateBlockInternal(
        fixtures.admin,
        "00000000-0000-0000-0000-000000000000",
        { reason: "noop" },
      ),
    ).rejects.toBeInstanceOf(BlockNotFoundError);
  });

  it("rejects reassigning to a non-existent resource", async () => {
    const created = await createBlockInternal(
      fixtures.admin,
      baseCreateInput(seeded.cage1.id, 18),
    );
    await expect(
      updateBlockInternal(fixtures.admin, created.id, {
        resourceId: "00000000-0000-0000-0000-000000000000",
      }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});

describe("deleteBlockInternal", () => {
  it("hard-deletes the row and writes an audit row with the before-snapshot", async () => {
    const created = await createBlockInternal(
      fixtures.admin,
      baseCreateInput(seeded.cage1.id, 19),
    );
    await deleteBlockInternal(fixtures.admin, created.id);

    const remaining = await db
      .select()
      .from(blockedTimes)
      .where(eq(blockedTimes.id, created.id));
    expect(remaining).toHaveLength(0);

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "block"),
          eq(auditLog.entityId, created.id),
          eq(auditLog.action, "delete"),
        ),
      );
    expect(audit).toBeDefined();
    const diff = audit.diff as { before: Record<string, unknown> };
    expect(diff.before.reason).toBe("HVAC maintenance");
    expect(diff.before.resourceId).toBe(seeded.cage1.id);
  });

  it("rejects deleting a non-existent block id", async () => {
    await expect(
      deleteBlockInternal(
        fixtures.admin,
        "00000000-0000-0000-0000-000000000000",
      ),
    ).rejects.toBeInstanceOf(BlockNotFoundError);
  });
});
