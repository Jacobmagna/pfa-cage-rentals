// Integration tests for the internal hour-log mutation logic. These
// hit a real Neon dev branch — see vitest.integration.config.ts and
// tests/integration/setup.ts for env wiring.
//
// We call the INTERNAL function (src/lib/server/hour-log-actions.ts)
// directly with a synthetic actor instead of going through the public
// "use server" wrapper in src/app/coach/hour-log/actions.ts. The
// wrapper adds requireSession() (covered separately via mocked auth);
// calling the internal here lets the test run without mocking
// framework internals.
//
// truncateMutables() does NOT touch `programs`, so every test creates
// its own program(s) with a unique name suffix and scopes assertions to
// the created program/coach ids. audit_log IS truncated between tests.

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
import { logHourInternal } from "@/lib/server/hour-log-actions";
import { ProgramInactiveError } from "@/lib/errors";
import {
  ensureFixtureUsers,
  truncateMutables,
  type FixtureUsers,
} from "./fixtures";

// logHourInternal → @/lib/authz → @/auth → next-auth, which fails to
// resolve in the vitest node environment. We never exercise the real
// auth() here (we call the internal fn with a synthetic actor), so
// stubbing @/auth is purely to break that import chain.
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

// Tomorrow at the given UTC hour. Far enough out that overlapping with
// any real fixture is impossible; hour_logs has no overlap constraint
// anyway, but keeps times sane.
function tomorrowAt(hour: number, minute = 0): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(hour, minute, 0, 0);
  return d;
}

// Unique suffix so concurrent / repeated runs never collide on the
// unique program name.
function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createProgram(active: boolean): Promise<{
  id: string;
  name: string;
}> {
  const name = `HourLog Test Program ${uniqueSuffix()}`;
  const [row] = await db
    .insert(programs)
    .values({ name, active })
    .returning({ id: programs.id, name: programs.name });
  return row;
}

// Inserts a scheduled program block with the given coach as a member
// (both the primary scheduledCoachId and a join row). The 1b held-then-
// approve gate (logHourInternal) only posts a log as "posted" when it
// CLEANLY matches such a block within ±15min on both ends, same program;
// otherwise it holds/throws. So any test that expects a log to POST must
// first create the matching block here. Returns the block id.
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

describe("logHourInternal", () => {
  it("admin logs an hour against an active program → row + audit row exist", async () => {
    const program = await createProgram(true);
    const startAt = tomorrowAt(10);
    const endAt = tomorrowAt(11);

    // 1b held-then-approve gate: a schedule-confirm log only posts when it
    // cleanly matches a scheduled block the coach is a member of. Create
    // the matching block (admin is the actor here, so admin is the member).
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
      note: "happy path",
      source: "schedule-confirm",
    });

    expect(created.id).toBeTruthy();
    expect(created.programId).toBe(program.id);
    expect(created.coachId).toBe(fixtures.admin.id);
    expect(created.createdBy).toBe(fixtures.admin.id);
    expect(created.note).toBe("happy path");

    const rows = await db
      .select()
      .from(hourLogs)
      .where(eq(hourLogs.id, created.id));
    expect(rows).toHaveLength(1);

    const audit = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.entityId, created.id), eq(auditLog.action, "create")),
      );
    expect(audit).toHaveLength(1);
    expect(audit[0].actorUserId).toBe(fixtures.admin.id);
    expect(audit[0].entityType).toBe("hour_log");
  });

  it("rejects end <= start (ZodError) and writes nothing", async () => {
    const program = await createProgram(true);

    await expect(
      logHourInternal(fixtures.admin, {
        programId: program.id,
        startAt: tomorrowAt(11),
        endAt: tomorrowAt(11),
        note: null,
      }),
    ).rejects.toBeInstanceOf(ZodError);

    const rows = await db
      .select()
      .from(hourLogs)
      .where(eq(hourLogs.programId, program.id));
    expect(rows).toHaveLength(0);
    const audits = await db.select().from(auditLog);
    expect(audits).toHaveLength(0);
  });

  it("rejects an inactive program with ProgramInactiveError and writes nothing", async () => {
    const program = await createProgram(false);

    const promise = logHourInternal(fixtures.admin, {
      programId: program.id,
      startAt: tomorrowAt(10),
      endAt: tomorrowAt(11),
      note: null,
    });

    await expect(promise).rejects.toBeInstanceOf(ProgramInactiveError);
    try {
      await promise;
    } catch (err) {
      const e = err as ProgramInactiveError;
      expect(e.programId).toBe(program.id);
      expect(e.programName).toBe(program.name);
    }

    const rows = await db
      .select()
      .from(hourLogs)
      .where(eq(hourLogs.programId, program.id));
    expect(rows).toHaveLength(0);
  });

  it("allows a coach to log against any active program — no assignment needed (DEC-29)", async () => {
    // Active program; the coach has NO coach_programs assignment (the
    // feature was removed). DEC-29: any coach may log against any active
    // program, so this writes a row + audit. The 1b held-then-approve gate
    // additionally requires a matching scheduled block for the log to POST
    // (vs. be held) — that's orthogonal to DEC-29's "no per-program
    // assignment needed" point, so we create one for this program/coach.
    const program = await createProgram(true);
    const startAt = tomorrowAt(13);
    const endAt = tomorrowAt(14);
    await createScheduledBlock({
      programId: program.id,
      coachId: fixtures.coach.id,
      startAt,
      endAt,
    });

    const created = await logHourInternal(fixtures.coach, {
      programId: program.id,
      startAt,
      endAt,
      note: "any-program",
      source: "schedule-confirm",
    });

    expect(created.coachId).toBe(fixtures.coach.id);
    expect(created.createdBy).toBe(fixtures.coach.id);
    expect(created.programId).toBe(program.id);

    const rows = await db
      .select()
      .from(hourLogs)
      .where(eq(hourLogs.programId, program.id));
    expect(rows).toHaveLength(1);

    const audit = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.entityId, created.id), eq(auditLog.action, "create")),
      );
    expect(audit).toHaveLength(1);
    expect(audit[0].actorUserId).toBe(fixtures.coach.id);
    expect(audit[0].entityType).toBe("hour_log");
  });
});
