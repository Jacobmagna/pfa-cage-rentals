// Integration tests for the 1b "held-then-approve" gate on manual hour
// logs. These hit a real Neon dev branch — see
// vitest.integration.config.ts and tests/integration/setup.ts for env
// wiring. Requires migration 0033 (status / held_reason columns).
//
// We call the INTERNAL functions (src/lib/server/hour-log-actions.ts)
// directly with a synthetic actor instead of going through the public
// "use server" wrappers, mirroring the other hour-log integration
// suites. The wrappers add only requireSession()/requireRole(), covered
// separately via mocked auth().
//
// truncateMutables() does NOT touch `programs`, `users`, `hour_logs`, or
// `program_schedule_blocks`, so every test creates its own program with
// a unique name suffix and scopes assertions to the created program/coach
// ids. We delete the program_schedule_blocks rows we create in afterEach
// (CASCADE removes the join rows). audit_log IS truncated between tests.

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  hourLogs,
  programScheduleBlockCoaches,
  programScheduleBlocks,
  programs,
} from "@/db/schema";
import {
  approveHeldHourLogInternal,
  countHeldHourLogs,
  loadHeldHourLogs,
  logHourInternal,
  rejectHeldHourLogInternal,
} from "@/lib/server/hour-log-actions";
import {
  HeldHourLogNotFoundError,
  HeldLogReviewRequiredError,
} from "@/lib/errors";
import {
  ensureFixtureUsers,
  truncateMutables,
  type FixtureUsers,
} from "./fixtures";

// logHourInternal → @/lib/authz → @/auth → next-auth, which fails to
// resolve in the vitest node environment. We never exercise the real
// auth() here (synthetic actor), so stubbing @/auth is purely to break
// that import chain.
vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

let fixtures: FixtureUsers;

// Track created rows for cleanup. hour_logs is NOT truncated, so we
// delete our own rows; program_schedule_blocks likewise.
const createdProgramIds: string[] = [];
const createdBlockIds: string[] = [];

beforeAll(async () => {
  fixtures = await ensureFixtureUsers();
});

beforeEach(async () => {
  await truncateMutables();
});

afterEach(async () => {
  if (createdProgramIds.length > 0) {
    await db
      .delete(hourLogs)
      .where(inArray(hourLogs.programId, createdProgramIds));
    createdProgramIds.length = 0;
  }
  if (createdBlockIds.length > 0) {
    // CASCADE removes the program_schedule_block_coaches join rows.
    await db
      .delete(programScheduleBlocks)
      .where(inArray(programScheduleBlocks.id, createdBlockIds));
    createdBlockIds.length = 0;
  }
});

// Tomorrow at the given UTC hour. Far enough out that overlapping with
// any real fixture is impossible.
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
  const name = `HourLog Held Test Program ${uniqueSuffix()}`;
  const [row] = await db
    .insert(programs)
    .values({ name, active: true })
    .returning({ id: programs.id, name: programs.name });
  createdProgramIds.push(row.id);
  return row;
}

// Inserts a scheduled program block with the given coach as a member
// (both the primary scheduledCoachId and a join row), returning its id.
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

describe("logHourInternal held-then-approve gate", () => {
  it("refuses a manual unscheduled log without acknowledgeHold (HeldLogReviewRequiredError) and writes nothing", async () => {
    const program = await createProgram();

    await expect(
      logHourInternal(fixtures.coach, {
        programId: program.id,
        startAt: tomorrowAt(10),
        endAt: tomorrowAt(11),
        note: "off-schedule",
      }),
    ).rejects.toBeInstanceOf(HeldLogReviewRequiredError);

    const rows = await db
      .select()
      .from(hourLogs)
      .where(eq(hourLogs.programId, program.id));
    expect(rows).toHaveLength(0);
  });

  it("holds a manual unscheduled log with acknowledgeHold:true (status=held, heldReason=unscheduled)", async () => {
    const program = await createProgram();

    const created = await logHourInternal(fixtures.coach, {
      programId: program.id,
      startAt: tomorrowAt(10),
      endAt: tomorrowAt(11),
      note: "off-schedule",
      acknowledgeHold: true,
    });

    expect(created.status).toBe("held");
    expect(created.heldReason).toBe("unscheduled");

    const [row] = await db
      .select()
      .from(hourLogs)
      .where(eq(hourLogs.id, created.id));
    expect(row).toBeTruthy();
    expect(row.status).toBe("held");
    expect(row.heldReason).toBe("unscheduled");
  });

  it("approveHeldHourLogInternal flips a held row to posted (reviewedAt set); a second approve throws HeldHourLogNotFoundError", async () => {
    const program = await createProgram();
    const held = await logHourInternal(fixtures.coach, {
      programId: program.id,
      startAt: tomorrowAt(10),
      endAt: tomorrowAt(11),
      note: "off-schedule",
      acknowledgeHold: true,
    });
    expect(held.status).toBe("held");

    const approved = await approveHeldHourLogInternal(fixtures.admin, held.id);
    expect(approved.status).toBe("posted");
    expect(approved.reviewedAt).not.toBeNull();

    const [row] = await db
      .select()
      .from(hourLogs)
      .where(eq(hourLogs.id, held.id));
    expect(row.status).toBe("posted");
    expect(row.reviewedAt).not.toBeNull();

    // No longer held → a second approve must fail.
    await expect(
      approveHeldHourLogInternal(fixtures.admin, held.id),
    ).rejects.toBeInstanceOf(HeldHourLogNotFoundError);
  });

  it("rejectHeldHourLogInternal deletes the held row", async () => {
    const program = await createProgram();
    const held = await logHourInternal(fixtures.coach, {
      programId: program.id,
      startAt: tomorrowAt(10),
      endAt: tomorrowAt(11),
      note: "off-schedule",
      acknowledgeHold: true,
    });
    expect(held.status).toBe("held");

    await rejectHeldHourLogInternal(fixtures.admin, held.id);

    const rows = await db
      .select()
      .from(hourLogs)
      .where(eq(hourLogs.id, held.id));
    expect(rows).toHaveLength(0);
  });

  it("posts a manual log that exactly matches a scheduled block without acknowledgeHold (clean path)", async () => {
    const program = await createProgram();
    const startAt = tomorrowAt(15);
    const endAt = tomorrowAt(16);
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
      note: "on-schedule",
    });

    expect(created.status).toBe("posted");
    expect(created.heldReason).toBeNull();

    const [row] = await db
      .select()
      .from(hourLogs)
      .where(eq(hourLogs.id, created.id));
    expect(row.status).toBe("posted");
  });

  it("loadHeldHourLogs returns only held rows and countHeldHourLogs matches", async () => {
    const program = await createProgram();

    // One held (unscheduled) row.
    const held = await logHourInternal(fixtures.coach, {
      programId: program.id,
      startAt: tomorrowAt(10),
      endAt: tomorrowAt(11),
      note: "held one",
      acknowledgeHold: true,
    });
    expect(held.status).toBe("held");

    // One posted row via the trusted auto-confirm path (never held).
    const posted = await logHourInternal(fixtures.coach, {
      programId: program.id,
      startAt: tomorrowAt(12),
      endAt: tomorrowAt(13),
      note: "posted one",
      source: "schedule-confirm",
    });
    expect(posted.status).toBe("posted");

    const heldRows = await loadHeldHourLogs();
    const ours = heldRows.filter((r) => r.programId === program.id);
    expect(ours).toHaveLength(1);
    expect(ours[0].id).toBe(held.id);
    expect(ours.every((r) => r.heldReason !== null)).toBe(true);

    // countHeldHourLogs counts ALL held rows; since this suite is the only
    // writer and we hold exactly one, the global count must agree.
    const count = await countHeldHourLogs();
    expect(count).toBe(heldRows.length);
    expect(count).toBeGreaterThanOrEqual(1);
  });
});
