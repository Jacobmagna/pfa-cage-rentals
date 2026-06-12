// Integration tests for the admin-side internal hour-log mutation
// logic (updateHourInternal / deleteHourInternal). These hit a real
// Neon dev branch — see vitest.integration.config.ts and
// tests/integration/setup.ts for env wiring.
//
// We call the INTERNAL functions (src/lib/server/hour-log-actions.ts)
// directly with a synthetic admin actor instead of going through the
// public "use server" wrappers in src/app/admin/hour-log/actions.ts.
// The wrappers add a single line — requireRole("admin") — covered
// separately via mocked auth(); calling internals here lets the test
// run without mocking framework internals.
//
// truncateMutables() does NOT touch `programs` or `hour_logs`, so every
// test creates its own program with a unique name suffix and scopes
// assertions to the created program/row ids. audit_log IS truncated
// between tests.

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  auditLog,
  hourLogs,
  programScheduleBlockCoaches,
  programScheduleBlocks,
  programs,
} from "@/db/schema";
import { ZodError } from "zod";
import {
  deleteHourInternal,
  logHourInternal,
  updateHourInternal,
} from "@/lib/server/hour-log-actions";
import { HourLogNotFoundError } from "@/lib/errors";
import {
  ensureFixtureUsers,
  truncateMutables,
  type FixtureUsers,
} from "./fixtures";

// logHourInternal → @/lib/authz → @/auth → next-auth, which fails to
// resolve in the vitest node environment. We never exercise real
// auth() here (synthetic actor), so stubbing @/auth is purely to break
// that import chain.
vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

let fixtures: FixtureUsers;

// Track scheduled blocks we create so we can clean them up. programs and
// program_schedule_blocks are NOT truncated by truncateMutables().
const createdBlockIds: string[] = [];

beforeAll(async () => {
  fixtures = await ensureFixtureUsers();
});

beforeEach(async () => {
  await truncateMutables();
});

afterEach(async () => {
  if (createdBlockIds.length > 0) {
    // CASCADE removes the program_schedule_block_coaches join rows.
    await db
      .delete(programScheduleBlocks)
      .where(inArray(programScheduleBlocks.id, createdBlockIds));
    createdBlockIds.length = 0;
  }
});

function tomorrowAt(hour: number, minute = 0): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(hour, minute, 0, 0);
  return d;
}

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createProgram(): Promise<{ id: string; name: string }> {
  const name = `HourLog Admin Test Program ${uniqueSuffix()}`;
  const [row] = await db
    .insert(programs)
    .values({ name, active: true })
    .returning({ id: programs.id, name: programs.name });
  return row;
}

// Inserts a scheduled program block with the given coach as a member
// (both the primary scheduledCoachId and a join row). The 1b held-then-
// approve gate only posts a log when it cleanly matches such a block, so
// seedHour() creates one matching its log window. Returns the block id.
async function createScheduledBlock(args: {
  programId: string;
  coachId: string;
  startAt: Date;
  endAt: Date;
}): Promise<string> {
  const [block] = await db
    .insert(programScheduleBlocks)
    .values({
      programId: args.programId,
      scheduledCoachId: args.coachId,
      startAt: args.startAt,
      endAt: args.endAt,
      createdBy: fixtures.admin.id,
    })
    .returning({ id: programScheduleBlocks.id });
  createdBlockIds.push(block.id);
  await db
    .insert(programScheduleBlockCoaches)
    .values({ blockId: block.id, coachId: args.coachId });
  return block.id;
}

// Logs one hour as admin against a fresh program, returning the row.
async function seedHour(): Promise<{
  id: string;
  programId: string;
  startAt: Date;
  endAt: Date;
}> {
  const program = await createProgram();
  const startAt = tomorrowAt(10);
  const endAt = tomorrowAt(11);
  // The schedule-confirm log below only POSTs when it cleanly matches a
  // scheduled block the actor (admin) is a member of (1b held-then-approve
  // gate). Create that matching block first.
  await createScheduledBlock({
    programId: program.id,
    coachId: fixtures.admin.id,
    startAt,
    endAt,
  });
  const created = await logHourInternal(fixtures.admin, {
    programId: program.id,
    startAt,
    endAt,
    note: "before",
    source: "schedule-confirm",
  });
  return {
    id: created.id,
    programId: program.id,
    startAt: created.startAt,
    endAt: created.endAt,
  };
}

describe("updateHourInternal", () => {
  it("edits the row and writes a changed-keys-only audit diff (before/after)", async () => {
    const seed = await seedHour();

    const updated = await updateHourInternal(fixtures.admin, seed.id, {
      programId: seed.programId,
      startAt: tomorrowAt(12),
      endAt: tomorrowAt(14),
      note: "after",
    });

    expect(updated.id).toBe(seed.id);
    expect(updated.note).toBe("after");
    expect(updated.startAt.getTime()).toBe(tomorrowAt(12).getTime());
    expect(updated.endAt.getTime()).toBe(tomorrowAt(14).getTime());

    const updateRows = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.entityId, seed.id), eq(auditLog.action, "update")),
      );
    expect(updateRows).toHaveLength(1);
    expect(updateRows[0].actorUserId).toBe(fixtures.admin.id);
    expect(updateRows[0].entityType).toBe("hour_log");

    const diff = updateRows[0].diff as {
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    };
    expect(diff.before.note).toBe("before");
    expect(diff.after.note).toBe("after");
    // programId didn't change → must not appear in the diff.
    expect(diff.before).not.toHaveProperty("programId");
    expect(diff.before).not.toHaveProperty("coachId");
  });

  it("rejects end <= start (ZodError) and leaves the row unchanged", async () => {
    const seed = await seedHour();

    await expect(
      updateHourInternal(fixtures.admin, seed.id, {
        programId: seed.programId,
        startAt: tomorrowAt(11),
        endAt: tomorrowAt(11),
        note: "after",
      }),
    ).rejects.toBeInstanceOf(ZodError);

    const [row] = await db
      .select()
      .from(hourLogs)
      .where(eq(hourLogs.id, seed.id));
    expect(row.note).toBe("before");
    expect(row.startAt.getTime()).toBe(seed.startAt.getTime());

    // No update audit row written.
    const updateRows = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.entityId, seed.id), eq(auditLog.action, "update")),
      );
    expect(updateRows).toHaveLength(0);
  });

  it("throws HourLogNotFoundError for a missing id", async () => {
    await expect(
      updateHourInternal(fixtures.admin, "does-not-exist", {
        programId: "x",
        startAt: tomorrowAt(10),
        endAt: tomorrowAt(11),
        note: null,
      }),
    ).rejects.toBeInstanceOf(HourLogNotFoundError);
  });
});

describe("deleteHourInternal", () => {
  it("removes the row and writes a delete audit row with the before snapshot", async () => {
    const seed = await seedHour();

    await deleteHourInternal(fixtures.admin, seed.id);

    const remaining = await db
      .select()
      .from(hourLogs)
      .where(eq(hourLogs.id, seed.id));
    expect(remaining).toHaveLength(0);

    const deleteAudit = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.entityId, seed.id), eq(auditLog.action, "delete")),
      );
    expect(deleteAudit).toHaveLength(1);
    const diff = deleteAudit[0].diff as { before: Record<string, unknown> };
    expect(diff.before).toBeTruthy();
    expect(diff.before.id).toBe(seed.id);
    expect(diff.before.coachId).toBe(fixtures.admin.id);
    expect(diff.before.note).toBe("before");
  });

  it("throws HourLogNotFoundError for a missing id", async () => {
    await expect(
      deleteHourInternal(fixtures.admin, "does-not-exist"),
    ).rejects.toBeInstanceOf(HourLogNotFoundError);
  });
});
