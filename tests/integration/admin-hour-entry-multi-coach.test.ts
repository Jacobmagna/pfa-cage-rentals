// ADMIN HOUR ENTRY × A BLOCK WITH TWO SCHEDULED COACHES.
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
// 2026-08-25, on PRODUCTION, the morning after admin hour entry shipped.
// Mark had a block more than two weeks old — so past `LOOKBACK_MS`, i.e. no
// coach could still self-confirm it — with TWO coaches scheduled on it,
// correctly showing red. He recorded the first coach's hours through the new
// "Log hours for a coach" dialog, went back to the schedule, and reported:
//   (a) the block read GREEN with only the first coach, and
//   (b) the second coach was no longer shown as posted on that slot;
// he then entered the second coach's hours and the dialog FROZE on
// "Recording…".
//
// Every existing test in `admin-hour-entry.test.ts` uses a single coach, and
// `block-recon-actions.test.ts` never runs an admin entry. The two features
// shipped in the same deploy and NOTHING covers their intersection — which is
// exactly the shape Mark hit. This file is that intersection.
//
// 🔴 THESE TESTS ASSERT WHAT THE PRODUCT SHOULD DO, NOT WHAT IT DOES. If the
// engine is right and the defect is in the browser, they pass and say so —
// which is itself the finding, because it narrows a production freeze to the
// client in one run instead of a session of guessing (rule 39).
//
// Day/isolation discipline is inherited from `admin-hour-entry.test.ts`: the
// overlap guard scans `hour_logs` BY COACH across a window and
// `truncateMutables()` does not touch that table, so every test takes its own
// calendar day in a year no other suite uses (rule 20).

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
  users,
} from "@/db/schema";
import { logHourForCoachInternal } from "@/lib/server/hour-log-actions";
import { createProgramScheduleBlockInternal } from "@/lib/server/program-schedule-actions";
import {
  reconcileBlocks,
  type ReconBlock,
  type ReconLog,
} from "@/lib/server/reconciliation";
import { formatPfaTime12h, parsePfaInput } from "@/lib/timezone";
import { ensureFixtureUsers, truncateMutables, type FixtureUsers } from "./fixtures";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

let fixtures: FixtureUsers;
let admin: FixtureUsers["admin"];

const createdProgramIds: string[] = [];
const createdBlockIds: string[] = [];
const createdUserIds: string[] = [];

// 2031 is claimed by no other suite. Each test takes the next day.
let dayCursor = 0;
function nextDay(): string {
  dayCursor += 1;
  const day = String((dayCursor % 27) + 1).padStart(2, "0");
  const month = String((Math.floor(dayCursor / 27) % 12) + 1).padStart(2, "0");
  return `2031-${month}-${day}`;
}

const at = (date: string, time: string) => parsePfaInput(date, time);

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createProgram(): Promise<{ id: string; name: string }> {
  const [row] = await db
    .insert(programs)
    .values({
      name: `Multi Coach Entry ${uniqueSuffix()}`,
      active: true,
      defaultRatePer30MinCents: 1500,
    })
    .returning({ id: programs.id, name: programs.name });
  createdProgramIds.push(row.id);
  return row;
}

async function createCoach(name: string): Promise<{ id: string; name: string }> {
  const [row] = await db
    .insert(users)
    .values({
      email: `multi-coach-${uniqueSuffix()}@test.invalid`,
      name,
      role: "coach",
    })
    .returning({ id: users.id, name: users.name });
  createdUserIds.push(row.id);
  return { id: row.id, name: row.name ?? name };
}

async function createBlock(opts: {
  programId: string;
  coachIds: string[];
  startAt: Date;
  endAt: Date;
}): Promise<{ id: string }> {
  const block = await createProgramScheduleBlockInternal(admin, {
    programId: opts.programId,
    scheduledCoachIds: opts.coachIds,
    startAt: opts.startAt,
    endAt: opts.endAt,
  });
  createdBlockIds.push(block.id);
  return { id: block.id };
}

/**
 * Rebuilds the reconciliation inputs the way `/admin/hour-log/schedule` does:
 * the block plus its FULL scheduled-coach set from the join table, and every
 * POSTED log overlapping the day.
 *
 * 🔴 Deliberately re-derived from the database rather than from the values the
 * test just wrote. The bug under investigation is a disagreement between what
 * was written and what the schedule renders, and a helper that echoes the
 * test's own inputs could not see it (rule 26 — a hand-built fixture cannot
 * test the code that produces it).
 */
async function reconcileFromDb(
  blockId: string,
  now: Date,
): Promise<ReturnType<typeof reconcileBlocks>[string]> {
  const [block] = await db
    .select()
    .from(programScheduleBlocks)
    .where(eq(programScheduleBlocks.id, blockId))
    .limit(1);
  if (!block) throw new Error(`block ${blockId} vanished`);

  const coachRows = await db
    .select({
      coachId: programScheduleBlockCoaches.coachId,
      coachName: users.name,
      coachEmail: users.email,
    })
    .from(programScheduleBlockCoaches)
    .innerJoin(users, eq(programScheduleBlockCoaches.coachId, users.id))
    .where(eq(programScheduleBlockCoaches.blockId, blockId));

  const reconBlock: ReconBlock = {
    id: block.id,
    programId: block.programId,
    scheduledCoachId: block.scheduledCoachId,
    scheduledCoachName:
      coachRows.find((c) => c.coachId === block.scheduledCoachId)?.coachName ??
      null,
    coaches: coachRows.map((c) => ({
      coachId: c.coachId,
      coachName: c.coachName ?? c.coachEmail,
    })),
    startAt: block.startAt,
    endAt: block.endAt,
  };

  // The schedule overlay is POSTED-only — 1b security B.
  const logRows = await db
    .select({
      coachId: hourLogs.coachId,
      coachName: users.name,
      coachEmail: users.email,
      programId: hourLogs.programId,
      startAt: hourLogs.startAt,
      endAt: hourLogs.endAt,
      status: hourLogs.status,
    })
    .from(hourLogs)
    .innerJoin(users, eq(hourLogs.coachId, users.id))
    .where(eq(hourLogs.programId, block.programId));

  const logs: ReconLog[] = logRows
    .filter((l) => l.status === "posted")
    .map((l) => ({
      coachId: l.coachId,
      coachName: l.coachName ?? l.coachEmail,
      programId: l.programId,
      startAt: l.startAt,
      endAt: l.endAt,
    }));

  return reconcileBlocks({ blocks: [reconBlock], logs, now }, formatPfaTime12h)[
    blockId
  ];
}

beforeAll(async () => {
  fixtures = await ensureFixtureUsers();
  admin = fixtures.admin;
});

beforeEach(async () => {
  await truncateMutables();
});

afterEach(async () => {
  // hour_logs BEFORE programs — `hour_logs.program_id` has no cascade.
  if (createdProgramIds.length > 0) {
    await db
      .delete(hourLogs)
      .where(inArray(hourLogs.programId, createdProgramIds));
  }
  if (createdBlockIds.length > 0) {
    await db
      .delete(programScheduleBlocks)
      .where(inArray(programScheduleBlocks.id, createdBlockIds));
    createdBlockIds.length = 0;
  }
  if (createdProgramIds.length > 0) {
    await db.delete(programs).where(inArray(programs.id, createdProgramIds));
    createdProgramIds.length = 0;
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
    createdUserIds.length = 0;
  }
});

/* ── MARK'S SEQUENCE, STEP BY STEP ───────────────────────────────────────── */

describe("an admin logs hours for each coach on a two-coach block", () => {
  it("reproduces the whole sequence: red → still red after one → green after both", async () => {
    const program = await createProgram();
    const coachA = await createCoach("Coach A");
    const coachB = await createCoach("Coach B");
    const day = nextDay();
    const startAt = at(day, "10:00");
    const endAt = at(day, "15:00");
    // Well past the block's end + NO_SHOW_BUFFER_MS, matching a shift that
    // happened more than two weeks ago.
    const now = at(day, "23:00");

    const block = await createBlock({
      programId: program.id,
      coachIds: [coachA.id, coachB.id],
      startAt,
      endAt,
    });

    // ── 1. Nobody has logged: red, and BOTH coaches are named. ──
    const before = await reconcileFromDb(block.id, now);
    expect(before.coaches).toHaveLength(2);
    expect(before.status).toBe("no_show");

    // ── 2. The admin records the FIRST coach's hours. ──
    const rowA = await logHourForCoachInternal(admin, {
      coachId: coachA.id,
      programId: program.id,
      startAt,
      endAt,
      note: "Entered by Mark",
    });
    expect(rowA!.status).toBe("posted");

    const afterFirst = await reconcileFromDb(block.id, now);

    // 🔴 THE ASSERTION THIS FILE EXISTS FOR. With one of two coaches logged
    // the block is NOT finished, so the bar must stay red and BOTH coaches
    // must still be on it. Mark reported seeing green with a single coach.
    expect(afterFirst.coaches).toHaveLength(2);
    const aAfterFirst = afterFirst.coaches.find((c) => c.coachId === coachA.id);
    const bAfterFirst = afterFirst.coaches.find((c) => c.coachId === coachB.id);
    expect(aAfterFirst?.status).toBe("logged");
    expect(bAfterFirst?.status).toBe("no_show");
    expect(afterFirst.status).toBe("no_show");

    // ── 3. The admin records the SECOND coach's hours. ──
    // This is the call that froze in the browser. If it throws or hangs here,
    // the defect is server-side; if it returns, the freeze is in the client.
    const rowB = await logHourForCoachInternal(admin, {
      coachId: coachB.id,
      programId: program.id,
      startAt,
      endAt,
      note: "Entered by Mark",
    });
    expect(rowB).toBeDefined();
    expect(rowB!.status).toBe("posted");
    expect(rowB!.coachId).toBe(coachB.id);

    // ── 4. Both logged → green, and two separate payable rows exist. ──
    const afterBoth = await reconcileFromDb(block.id, now);
    expect(afterBoth.status).toBe("logged");
    expect(
      afterBoth.coaches.every((c) => c.status === "logged"),
    ).toBe(true);

    const rows = await db
      .select()
      .from(hourLogs)
      .where(eq(hourLogs.programId, program.id));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.coachId))).toEqual(
      new Set([coachA.id, coachB.id]),
    );
  });

  // The money question underneath the display one: two coaches on the same
  // window are two separate payable rows, and neither one's entry may
  // suppress or re-price the other. The overlap guard is scoped BY COACH, so
  // a second coach at the identical window must NOT read as a double-pay.
  it("does not treat a second COACH at the same window as an overlap", async () => {
    const program = await createProgram();
    const coachA = await createCoach("Coach A");
    const coachB = await createCoach("Coach B");
    const day = nextDay();
    const startAt = at(day, "09:00");
    const endAt = at(day, "12:00");

    await logHourForCoachInternal(admin, {
      coachId: coachA.id,
      programId: program.id,
      startAt,
      endAt,
    });

    // No confirmWarnings — if the guard wrongly fired this would throw
    // AdminHourEntryNotConfirmedError and the admin would be told, falsely,
    // that recording it pays somebody twice.
    const rowB = await logHourForCoachInternal(admin, {
      coachId: coachB.id,
      programId: program.id,
      startAt,
      endAt,
    });

    expect(rowB!.coachId).toBe(coachB.id);
    expect(rowB!.status).toBe("posted");
    // Each priced on its own merits, neither zeroed by the other.
    expect(rowB!.ratePer30MinCents).toBe(1500);
  });

  // The same shape one step further out: the second coach is entered while
  // the first coach's identical row already exists, which is the exact
  // collision the unique index sees. It must not upgrade, mutate or return
  // the FIRST coach's row.
  it("never returns or mutates the first coach's row when entering the second", async () => {
    const program = await createProgram();
    const coachA = await createCoach("Coach A");
    const coachB = await createCoach("Coach B");
    const day = nextDay();
    const startAt = at(day, "13:00");
    const endAt = at(day, "16:00");

    const rowA = await logHourForCoachInternal(admin, {
      coachId: coachA.id,
      programId: program.id,
      startAt,
      endAt,
    });
    const rowB = await logHourForCoachInternal(admin, {
      coachId: coachB.id,
      programId: program.id,
      startAt,
      endAt,
    });

    expect(rowB!.id).not.toBe(rowA!.id);

    const [reReadA] = await db
      .select()
      .from(hourLogs)
      .where(eq(hourLogs.id, rowA!.id));
    expect(reReadA.coachId).toBe(coachA.id);
    expect(reReadA.status).toBe("posted");
  });
});
