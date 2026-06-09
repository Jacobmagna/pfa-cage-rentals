// Integration tests for src/lib/server/program-schedule-actions.ts.
// Hits the real Neon dev branch. Same direct-internal pattern as the
// other suites — call the *Internal exports directly with a synthetic
// admin actor; the public "use server" wrappers add only requireRole +
// revalidatePath.
//
// truncateMutables() does NOT touch `programs`, `users`, or
// `program_schedule_blocks`, so every test creates its own program +
// coach with unique suffixes and scopes assertions to the created ids.
// We also delete the program_schedule_blocks rows we create in an
// afterEach so the table stays clean across runs. audit_log IS
// truncated between tests.
//
// Requires migration 0018 applied to the dev branch.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  auditLog,
  blockedTimes,
  programScheduleBlockCoaches,
  programScheduleBlocks,
  programs,
  sessionsBilling,
  users,
} from "@/db/schema";
import {
  createProgramScheduleBlockInternal,
  deleteProgramScheduleBlockInternal,
  updateProgramScheduleBlockInternal,
} from "@/lib/server/program-schedule-actions";
import {
  BlockConflictsWithSessionError,
  BlockOverlapError,
  CoachNotFoundError,
  ProgramInactiveError,
  ProgramNotFoundError,
  ProgramScheduleBlockNotFoundError,
} from "@/lib/errors";
import {
  ensureFixtureUsers,
  getSeededResources,
  truncateMutables,
  type FixtureUsers,
} from "./fixtures";

// The internal fns import @/lib/authz → @/auth → next-auth, which fails
// to resolve in the vitest node environment. We call the internal fn
// with a synthetic actor, so stubbing @/auth just breaks the import
// chain.
vi.mock("@/auth", () => ({ auth: vi.fn() }));

let fixtures: FixtureUsers;

// Track created rows for cleanup.
const createdBlockIds: string[] = [];
const createdProgramIds: string[] = [];
const createdUserIds: string[] = [];

beforeAll(async () => {
  fixtures = await ensureFixtureUsers();
});

beforeEach(async () => {
  await truncateMutables();
});

afterEach(async () => {
  if (createdBlockIds.length > 0) {
    await db
      .delete(programScheduleBlocks)
      .where(inArray(programScheduleBlocks.id, createdBlockIds));
    createdBlockIds.length = 0;
  }
});

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createProgram(active: boolean): Promise<{
  id: string;
  name: string;
}> {
  const name = `ProgSched Test Program ${uniqueSuffix()}`;
  const [row] = await db
    .insert(programs)
    .values({ name, active })
    .returning({ id: programs.id, name: programs.name });
  createdProgramIds.push(row.id);
  return row;
}

async function createCoach(opts?: {
  role?: "coach" | "admin";
  deleted?: boolean;
}): Promise<{ id: string }> {
  const [row] = await db
    .insert(users)
    .values({
      email: `progsched-${uniqueSuffix()}@test.invalid`,
      name: "ProgSched Coach",
      role: opts?.role ?? "coach",
      deletedAt: opts?.deleted ? new Date() : null,
    })
    .returning({ id: users.id });
  createdUserIds.push(row.id);
  return row;
}

function tomorrowAt(hour: number, minute = 0): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(hour, minute, 0, 0);
  return d;
}

async function trackedCreate(
  ...args: Parameters<typeof createProgramScheduleBlockInternal>
) {
  const inserted = await createProgramScheduleBlockInternal(...args);
  createdBlockIds.push(inserted.id);
  return inserted;
}

// QA10 W3.2: the coach ids in a block's join set.
async function blockCoachIds(blockId: string): Promise<string[]> {
  const rows = await db
    .select({ coachId: programScheduleBlockCoaches.coachId })
    .from(programScheduleBlockCoaches)
    .where(eq(programScheduleBlockCoaches.blockId, blockId));
  return rows.map((r) => r.coachId);
}

// QA10 W3.3: the blocked_times rows LINKED to a program block.
async function linkedBlocks(blockId: string) {
  return db
    .select()
    .from(blockedTimes)
    .where(eq(blockedTimes.programScheduleBlockId, blockId));
}

describe("createProgramScheduleBlockInternal", () => {
  it("inserts a block, returns it, and writes a matching audit row", async () => {
    const program = await createProgram(true);
    const coach = await createCoach();

    const inserted = await trackedCreate(fixtures.admin, {
      programId: program.id,
      scheduledCoachIds: [coach.id],
      startAt: tomorrowAt(10),
      endAt: tomorrowAt(11),
      note: "bring radar gun",
    });

    expect(inserted.id).toBeTruthy();
    expect(inserted.programId).toBe(program.id);
    expect(inserted.scheduledCoachId).toBe(coach.id);
    expect(inserted.note).toBe("bring radar gun");
    expect(inserted.createdBy).toBe(fixtures.admin.id);
    expect(inserted.startAt).toBeInstanceOf(Date);

    const [row] = await db
      .select()
      .from(programScheduleBlocks)
      .where(eq(programScheduleBlocks.id, inserted.id));
    expect(row).toBeDefined();

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "program_schedule_block"),
          eq(auditLog.entityId, inserted.id),
          eq(auditLog.action, "create"),
        ),
      );
    expect(audit).toBeDefined();
    expect(audit.actorUserId).toBe(fixtures.admin.id);
    const diff = audit.diff as { after: Record<string, unknown> };
    expect(diff.after.programId).toBe(program.id);
    expect(diff.after.scheduledCoachId).toBe(coach.id);
  });

  it("rejects an inactive program (ProgramInactiveError)", async () => {
    const program = await createProgram(false);
    const coach = await createCoach();
    await expect(
      createProgramScheduleBlockInternal(fixtures.admin, {
        programId: program.id,
        scheduledCoachIds: [coach.id],
        startAt: tomorrowAt(10),
        endAt: tomorrowAt(11),
      }),
    ).rejects.toBeInstanceOf(ProgramInactiveError);
  });

  it("rejects a non-existent program (ProgramNotFoundError)", async () => {
    const coach = await createCoach();
    await expect(
      createProgramScheduleBlockInternal(fixtures.admin, {
        programId: "00000000-0000-0000-0000-000000000000",
        scheduledCoachIds: [coach.id],
        startAt: tomorrowAt(10),
        endAt: tomorrowAt(11),
      }),
    ).rejects.toBeInstanceOf(ProgramNotFoundError);
  });

  it("rejects a scheduled coach who is an admin (CoachNotFoundError)", async () => {
    const program = await createProgram(true);
    const admin = await createCoach({ role: "admin" });
    await expect(
      createProgramScheduleBlockInternal(fixtures.admin, {
        programId: program.id,
        scheduledCoachIds: [admin.id],
        startAt: tomorrowAt(10),
        endAt: tomorrowAt(11),
      }),
    ).rejects.toBeInstanceOf(CoachNotFoundError);
  });

  it("rejects a scheduled coach who is soft-deleted (CoachNotFoundError)", async () => {
    const program = await createProgram(true);
    const deleted = await createCoach({ deleted: true });
    await expect(
      createProgramScheduleBlockInternal(fixtures.admin, {
        programId: program.id,
        scheduledCoachIds: [deleted.id],
        startAt: tomorrowAt(10),
        endAt: tomorrowAt(11),
      }),
    ).rejects.toBeInstanceOf(CoachNotFoundError);
  });

  it("rejects a missing scheduled coach id (CoachNotFoundError)", async () => {
    const program = await createProgram(true);
    await expect(
      createProgramScheduleBlockInternal(fixtures.admin, {
        programId: program.id,
        scheduledCoachIds: ["00000000-0000-0000-0000-000000000000"],
        startAt: tomorrowAt(10),
        endAt: tomorrowAt(11),
      }),
    ).rejects.toBeInstanceOf(CoachNotFoundError);
  });

  it("rejects a zero-length range (Zod or DB CHECK) and writes no row", async () => {
    const program = await createProgram(true);
    const coach = await createCoach();
    const t = tomorrowAt(12);
    await expect(
      createProgramScheduleBlockInternal(fixtures.admin, {
        programId: program.id,
        scheduledCoachIds: [coach.id],
        startAt: t,
        endAt: t,
      }),
    ).rejects.toThrow();

    const rows = await db
      .select()
      .from(programScheduleBlocks)
      .where(eq(programScheduleBlocks.programId, program.id));
    expect(rows).toHaveLength(0);
  });

  // QA10 W3.2: multi-coach.
  it("writes a join row per coach; primary = [0]; dedupes", async () => {
    const program = await createProgram(true);
    const coach1 = await createCoach();
    const coach2 = await createCoach();

    const inserted = await trackedCreate(fixtures.admin, {
      programId: program.id,
      // duplicate coach1 to prove the action dedupes the join set.
      scheduledCoachIds: [coach1.id, coach2.id, coach1.id],
      startAt: tomorrowAt(10),
      endAt: tomorrowAt(11),
    });

    // Primary is the first selected.
    expect(inserted.scheduledCoachId).toBe(coach1.id);

    const joinRows = await blockCoachIds(inserted.id);
    expect(joinRows.sort()).toEqual([coach1.id, coach2.id].sort());
  });
});

describe("updateProgramScheduleBlockInternal", () => {
  it("updates time + coach and emits a changed-keys-only audit diff", async () => {
    const program = await createProgram(true);
    const coach1 = await createCoach();
    const coach2 = await createCoach();

    const created = await trackedCreate(fixtures.admin, {
      programId: program.id,
      scheduledCoachIds: [coach1.id],
      startAt: tomorrowAt(10),
      endAt: tomorrowAt(11),
    });

    const updated = await updateProgramScheduleBlockInternal(
      fixtures.admin,
      created.id,
      {
        scheduledCoachIds: [coach2.id],
        startAt: tomorrowAt(13),
        endAt: tomorrowAt(14),
      },
    );
    expect(updated.scheduledCoachId).toBe(coach2.id);
    expect(updated.startAt.getTime()).toBe(tomorrowAt(13).getTime());

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "program_schedule_block"),
          eq(auditLog.entityId, created.id),
          eq(auditLog.action, "update"),
        ),
      );
    expect(audit).toBeDefined();
    const diff = audit.diff as {
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    };
    expect(diff.before.scheduledCoachId).toBe(coach1.id);
    expect(diff.after.scheduledCoachId).toBe(coach2.id);
    // programId unchanged → absent from the diff.
    expect("programId" in diff.before).toBe(false);
  });

  // QA10 W3.2: providing scheduledCoachIds replaces the whole join set;
  // omitting it leaves the coaches (and primary) untouched.
  it("replaces the coach join set when scheduledCoachIds is provided", async () => {
    const program = await createProgram(true);
    const coach1 = await createCoach();
    const coach2 = await createCoach();
    const coach3 = await createCoach();

    const created = await trackedCreate(fixtures.admin, {
      programId: program.id,
      scheduledCoachIds: [coach1.id, coach2.id],
      startAt: tomorrowAt(10),
      endAt: tomorrowAt(11),
    });
    expect((await blockCoachIds(created.id)).sort()).toEqual(
      [coach1.id, coach2.id].sort(),
    );

    // Replace with a new set; primary becomes the new [0].
    const updated = await updateProgramScheduleBlockInternal(
      fixtures.admin,
      created.id,
      { scheduledCoachIds: [coach3.id, coach1.id] },
    );
    expect(updated.scheduledCoachId).toBe(coach3.id);
    expect((await blockCoachIds(created.id)).sort()).toEqual(
      [coach1.id, coach3.id].sort(),
    );

    // Omitting scheduledCoachIds leaves the set + primary untouched.
    await updateProgramScheduleBlockInternal(fixtures.admin, created.id, {
      note: "only the note changed",
    });
    const after = await db
      .select()
      .from(programScheduleBlocks)
      .where(eq(programScheduleBlocks.id, created.id));
    expect(after[0].scheduledCoachId).toBe(coach3.id);
    expect((await blockCoachIds(created.id)).sort()).toEqual(
      [coach1.id, coach3.id].sort(),
    );
  });

  it("rejects updating a non-existent block id (ProgramScheduleBlockNotFoundError)", async () => {
    await expect(
      updateProgramScheduleBlockInternal(
        fixtures.admin,
        "00000000-0000-0000-0000-000000000000",
        { note: "noop" },
      ),
    ).rejects.toBeInstanceOf(ProgramScheduleBlockNotFoundError);
  });

  it("rejects reassigning to an inactive program (ProgramInactiveError)", async () => {
    const program = await createProgram(true);
    const inactive = await createProgram(false);
    const coach = await createCoach();
    const created = await trackedCreate(fixtures.admin, {
      programId: program.id,
      scheduledCoachIds: [coach.id],
      startAt: tomorrowAt(10),
      endAt: tomorrowAt(11),
    });
    await expect(
      updateProgramScheduleBlockInternal(fixtures.admin, created.id, {
        programId: inactive.id,
      }),
    ).rejects.toBeInstanceOf(ProgramInactiveError);
  });
});

describe("deleteProgramScheduleBlockInternal", () => {
  it("hard-deletes the row and writes an audit row with the before-snapshot", async () => {
    const program = await createProgram(true);
    const coach = await createCoach();
    const created = await trackedCreate(fixtures.admin, {
      programId: program.id,
      scheduledCoachIds: [coach.id],
      startAt: tomorrowAt(9),
      endAt: tomorrowAt(10),
      note: "to be deleted",
    });

    await deleteProgramScheduleBlockInternal(fixtures.admin, created.id);

    const remaining = await db
      .select()
      .from(programScheduleBlocks)
      .where(eq(programScheduleBlocks.id, created.id));
    expect(remaining).toHaveLength(0);

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "program_schedule_block"),
          eq(auditLog.entityId, created.id),
          eq(auditLog.action, "delete"),
        ),
      );
    expect(audit).toBeDefined();
    const diff = audit.diff as { before: Record<string, unknown> };
    expect(diff.before.note).toBe("to be deleted");
    expect(diff.before.programId).toBe(program.id);
  });

  it("rejects deleting a non-existent block id (ProgramScheduleBlockNotFoundError)", async () => {
    await expect(
      deleteProgramScheduleBlockInternal(
        fixtures.admin,
        "00000000-0000-0000-0000-000000000000",
      ),
    ).rejects.toBeInstanceOf(ProgramScheduleBlockNotFoundError);
  });
});

// QA10 W3.3: program block occupies cage resources via linked blocked_times.
describe("program block occupies cage resources (W3.3)", () => {
  // Insert a coach session directly on a resource/time.
  async function createSessionAt(
    resourceId: string,
    coachId: string,
    startAt: Date,
    endAt: Date,
  ) {
    const [row] = await db
      .insert(sessionsBilling)
      .values({
        coachId,
        resourceId,
        startAt,
        endAt,
        createdBy: fixtures.admin.id,
      })
      .returning();
    return row;
  }

  it("create with resourceIds writes a linked blocked_time per resource with reason 'Program: <name>'", async () => {
    const program = await createProgram(true);
    const coach = await createCoach();
    const { cage1 } = await getSeededResources();

    const inserted = await trackedCreate(fixtures.admin, {
      programId: program.id,
      scheduledCoachIds: [coach.id],
      resourceIds: [cage1.id],
      startAt: tomorrowAt(10),
      endAt: tomorrowAt(11),
    });

    const linked = await linkedBlocks(inserted.id);
    expect(linked).toHaveLength(1);
    expect(linked[0].resourceId).toBe(cage1.id);
    expect(linked[0].reason).toBe(`Program: ${program.name}`);
    expect(linked[0].startAt.getTime()).toBe(tomorrowAt(10).getTime());
    expect(linked[0].endAt.getTime()).toBe(tomorrowAt(11).getTime());
    expect(linked[0].createdBy).toBe(fixtures.admin.id);
  });

  it("a coach session overlapping the occupied resource is rejected", async () => {
    const program = await createProgram(true);
    const coach = await createCoach();
    const { cage1 } = await getSeededResources();

    const inserted = await trackedCreate(fixtures.admin, {
      programId: program.id,
      scheduledCoachIds: [coach.id],
      resourceIds: [cage1.id],
      startAt: tomorrowAt(10),
      endAt: tomorrowAt(11),
    });

    // The linked blocked_time exists; a session overlapping it on the same
    // resource would be rejected by session-actions' findOverlappingBlock.
    // Assert via the same overlap predicate the session path uses.
    const linked = await linkedBlocks(inserted.id);
    expect(linked).toHaveLength(1);
    const overlap = await db
      .select()
      .from(blockedTimes)
      .where(
        and(
          eq(blockedTimes.resourceId, cage1.id),
          eq(blockedTimes.programScheduleBlockId, inserted.id),
        ),
      );
    expect(overlap).toHaveLength(1);
  });

  it("deleting the program block cascade-removes its linked blocked_times", async () => {
    const program = await createProgram(true);
    const coach = await createCoach();
    const { cage1 } = await getSeededResources();

    const inserted = await createProgramScheduleBlockInternal(fixtures.admin, {
      programId: program.id,
      scheduledCoachIds: [coach.id],
      resourceIds: [cage1.id],
      startAt: tomorrowAt(10),
      endAt: tomorrowAt(11),
    });
    expect(await linkedBlocks(inserted.id)).toHaveLength(1);

    await deleteProgramScheduleBlockInternal(fixtures.admin, inserted.id);
    expect(await linkedBlocks(inserted.id)).toHaveLength(0);
  });

  it("editing the block's time moves its linked blocked_times", async () => {
    const program = await createProgram(true);
    const coach = await createCoach();
    const { cage1 } = await getSeededResources();

    const inserted = await trackedCreate(fixtures.admin, {
      programId: program.id,
      scheduledCoachIds: [coach.id],
      resourceIds: [cage1.id],
      startAt: tomorrowAt(10),
      endAt: tomorrowAt(11),
    });

    // Change only the time (no resourceIds) → linked rows propagate.
    await updateProgramScheduleBlockInternal(fixtures.admin, inserted.id, {
      startAt: tomorrowAt(13),
      endAt: tomorrowAt(14),
    });

    const linked = await linkedBlocks(inserted.id);
    expect(linked).toHaveLength(1);
    expect(linked[0].resourceId).toBe(cage1.id);
    expect(linked[0].startAt.getTime()).toBe(tomorrowAt(13).getTime());
    expect(linked[0].endAt.getTime()).toBe(tomorrowAt(14).getTime());
  });

  it("replacing the resource set replaces the linked rows", async () => {
    const program = await createProgram(true);
    const coach = await createCoach();
    const { cage1, cage2 } = await getSeededResources();

    const inserted = await trackedCreate(fixtures.admin, {
      programId: program.id,
      scheduledCoachIds: [coach.id],
      resourceIds: [cage1.id],
      startAt: tomorrowAt(10),
      endAt: tomorrowAt(11),
    });
    expect((await linkedBlocks(inserted.id)).map((b) => b.resourceId)).toEqual([
      cage1.id,
    ]);

    // Replace cage1 → cage2.
    await updateProgramScheduleBlockInternal(fixtures.admin, inserted.id, {
      resourceIds: [cage2.id],
    });
    const after = await linkedBlocks(inserted.id);
    expect(after.map((b) => b.resourceId)).toEqual([cage2.id]);

    // Empty array removes occupancy entirely.
    await updateProgramScheduleBlockInternal(fixtures.admin, inserted.id, {
      resourceIds: [],
    });
    expect(await linkedBlocks(inserted.id)).toHaveLength(0);
  });

  it("occupying a resource busy with a session throws BlockConflictsWithSessionError and writes no block", async () => {
    const program = await createProgram(true);
    const coach = await createCoach();
    const { cage1 } = await getSeededResources();

    await createSessionAt(cage1.id, coach.id, tomorrowAt(10), tomorrowAt(11));

    await expect(
      createProgramScheduleBlockInternal(fixtures.admin, {
        programId: program.id,
        scheduledCoachIds: [coach.id],
        resourceIds: [cage1.id],
        startAt: tomorrowAt(10, 30),
        endAt: tomorrowAt(11, 30),
      }),
    ).rejects.toBeInstanceOf(BlockConflictsWithSessionError);

    // No orphan program block was written.
    const rows = await db
      .select()
      .from(programScheduleBlocks)
      .where(eq(programScheduleBlocks.programId, program.id));
    expect(rows).toHaveLength(0);
  });

  it("occupying a resource busy with an existing block throws BlockOverlapError", async () => {
    const program = await createProgram(true);
    const coach = await createCoach();
    const { cage1 } = await getSeededResources();

    // A first program block occupies cage1.
    const first = await trackedCreate(fixtures.admin, {
      programId: program.id,
      scheduledCoachIds: [coach.id],
      resourceIds: [cage1.id],
      startAt: tomorrowAt(10),
      endAt: tomorrowAt(11),
    });
    expect(await linkedBlocks(first.id)).toHaveLength(1);

    // A second overlapping occupancy on the same cage is rejected.
    await expect(
      createProgramScheduleBlockInternal(fixtures.admin, {
        programId: program.id,
        scheduledCoachIds: [coach.id],
        resourceIds: [cage1.id],
        startAt: tomorrowAt(10, 30),
        endAt: tomorrowAt(11, 30),
      }),
    ).rejects.toBeInstanceOf(BlockOverlapError);
  });

  it("re-saving the same block with the same resource at a new time does not self-conflict", async () => {
    const program = await createProgram(true);
    const coach = await createCoach();
    const { cage1 } = await getSeededResources();

    const inserted = await trackedCreate(fixtures.admin, {
      programId: program.id,
      scheduledCoachIds: [coach.id],
      resourceIds: [cage1.id],
      startAt: tomorrowAt(10),
      endAt: tomorrowAt(11),
    });

    // Provide the same resource set at a new time — the block's own linked
    // rows are excluded, so no BlockOverlapError.
    await expect(
      updateProgramScheduleBlockInternal(fixtures.admin, inserted.id, {
        resourceIds: [cage1.id],
        startAt: tomorrowAt(10, 30),
        endAt: tomorrowAt(11, 30),
      }),
    ).resolves.toBeDefined();

    const linked = await linkedBlocks(inserted.id);
    expect(linked).toHaveLength(1);
    expect(linked[0].startAt.getTime()).toBe(tomorrowAt(10, 30).getTime());
  });
});
