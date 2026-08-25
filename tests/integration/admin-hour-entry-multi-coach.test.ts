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
import {
  AdminHourEntryNotConfirmedError,
  HourLogSubjectNotFoundError,
} from "@/lib/errors";
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
  // By PROGRAM, not by tracked id — the schedule sync creates blocks this
  // file never asked for, and `program_schedule_blocks.program_id` has no
  // cascade, so anything missed here fails the program delete with a 23503
  // and reads exactly like a product defect (rule 20).
  if (createdProgramIds.length > 0) {
    await db
      .delete(programScheduleBlocks)
      .where(inArray(programScheduleBlocks.programId, createdProgramIds));
    createdBlockIds.length = 0;
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

    // ── 2. The admin records the FIRST coach's hours, ALONE. ──
    const first = await logHourForCoachInternal(admin, {
      coachIds: [coachA.id],
      programId: program.id,
      startAt,
      endAt,
      note: "Entered by Mark",
    });
    expect(first.logs[0]!.status).toBe("posted");

    const afterFirst = await reconcileFromDb(block.id, now);

    // 🔴 THE ASSERTION THIS FILE EXISTS FOR. With one of two coaches logged
    // the block is NOT finished, so the bar must stay red and BOTH coaches
    // must still be on it. Mark reported seeing green with a single coach.
    expect(afterFirst.coaches).toHaveLength(2);
    expect(
      afterFirst.coaches.find((c) => c.coachId === coachA.id)?.status,
    ).toBe("logged");
    expect(
      afterFirst.coaches.find((c) => c.coachId === coachB.id)?.status,
    ).toBe("no_show");
    expect(afterFirst.status).toBe("no_show");

    // ── 3. The admin records the SECOND coach's hours. ──
    const second = await logHourForCoachInternal(admin, {
      coachIds: [coachB.id],
      programId: program.id,
      startAt,
      endAt,
      note: "Entered by Mark",
    });
    expect(second.logs[0]!.coachId).toBe(coachB.id);
    expect(second.logs[0]!.status).toBe("posted");

    // ── 4. Both logged → green, and two separate payable rows exist. ──
    const afterBoth = await reconcileFromDb(block.id, now);
    expect(afterBoth.status).toBe("logged");
    expect(afterBoth.coaches.every((c) => c.status === "logged")).toBe(true);

    const rows = await db
      .select()
      .from(hourLogs)
      .where(eq(hourLogs.programId, program.id));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.coachId))).toEqual(
      new Set([coachA.id, coachB.id]),
    );
  });

  // The whole point of the multi-coach change: what took two runs of the
  // dialog, with a half-recorded schedule in between, is now one.
  it("records BOTH coaches from ONE submit and the block goes green at once", async () => {
    const program = await createProgram();
    const coachA = await createCoach("Coach A");
    const coachB = await createCoach("Coach B");
    const day = nextDay();
    const startAt = at(day, "10:00");
    const endAt = at(day, "15:00");
    const now = at(day, "23:00");

    const block = await createBlock({
      programId: program.id,
      coachIds: [coachA.id, coachB.id],
      startAt,
      endAt,
    });
    expect((await reconcileFromDb(block.id, now)).status).toBe("no_show");

    const result = await logHourForCoachInternal(admin, {
      coachIds: [coachA.id, coachB.id],
      programId: program.id,
      startAt,
      endAt,
    });

    expect(result.logs).toHaveLength(2);
    expect(new Set(result.logs.map((l) => l!.coachId))).toEqual(
      new Set([coachA.id, coachB.id]),
    );
    // Each priced on its own merits — one coach's entry must never rate the
    // other's row.
    expect(result.logs.every((l) => l!.ratePer30MinCents === 1500)).toBe(true);

    const after = await reconcileFromDb(block.id, now);
    expect(after.status).toBe("logged");
  });

  // The same coach ticked twice is a slip, not an instruction to pay twice.
  it("dedupes a coach named twice in one submit", async () => {
    const program = await createProgram();
    const coachA = await createCoach("Coach A");
    const day = nextDay();

    const result = await logHourForCoachInternal(admin, {
      coachIds: [coachA.id, coachA.id],
      programId: program.id,
      startAt: at(day, "10:00"),
      endAt: at(day, "12:00"),
    });

    expect(result.logs).toHaveLength(1);
    const rows = await db
      .select()
      .from(hourLogs)
      .where(eq(hourLogs.programId, program.id));
    expect(rows).toHaveLength(1);
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
      coachIds: [coachA.id],
      programId: program.id,
      startAt,
      endAt,
    });

    // No confirmWarnings — if the guard wrongly fired this would throw
    // AdminHourEntryNotConfirmedError and the admin would be told, falsely,
    // that recording it pays somebody twice.
    const result = await logHourForCoachInternal(admin, {
      coachIds: [coachB.id],
      programId: program.id,
      startAt,
      endAt,
    });

    expect(result.logs[0]!.coachId).toBe(coachB.id);
    expect(result.logs[0]!.ratePer30MinCents).toBe(1500);
  });

  it("never returns or mutates the first coach's row when entering the second", async () => {
    const program = await createProgram();
    const coachA = await createCoach("Coach A");
    const coachB = await createCoach("Coach B");
    const day = nextDay();
    const startAt = at(day, "13:00");
    const endAt = at(day, "16:00");

    const first = await logHourForCoachInternal(admin, {
      coachIds: [coachA.id],
      programId: program.id,
      startAt,
      endAt,
    });
    const second = await logHourForCoachInternal(admin, {
      coachIds: [coachB.id],
      programId: program.id,
      startAt,
      endAt,
    });

    expect(second.logs[0]!.id).not.toBe(first.logs[0]!.id);

    const [reReadA] = await db
      .select()
      .from(hourLogs)
      .where(eq(hourLogs.id, first.logs[0]!.id));
    expect(reReadA.coachId).toBe(coachA.id);
    expect(reReadA.status).toBe("posted");
  });
});

/* ── WARNINGS ACROSS SEVERAL COACHES ─────────────────────────────────────── */

describe("warnings when one submit covers several coaches", () => {
  // Jacob's decision: warn once, name who, confirm all. The admin is making
  // ONE decision about ONE shift, so he reads one screen.
  it("collects every coach's warnings into ONE refusal, each naming its coach", async () => {
    const program = await createProgram();
    const coachA = await createCoach("Coach A");
    const coachB = await createCoach("Coach B");
    const day = nextDay();

    // Give BOTH coaches something to clash with — a partial overlap, which
    // is the case no database constraint can see.
    for (const c of [coachA, coachB]) {
      await logHourForCoachInternal(admin, {
        coachIds: [c.id],
        programId: program.id,
        startAt: at(day, "10:00"),
        endAt: at(day, "15:00"),
      });
    }

    let caught: unknown;
    try {
      await logHourForCoachInternal(admin, {
        coachIds: [coachA.id, coachB.id],
        programId: program.id,
        startAt: at(day, "10:00"),
        endAt: at(day, "14:00"),
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AdminHourEntryNotConfirmedError);
    const warnings = (caught as AdminHourEntryNotConfirmedError).warnings;
    // 🔴 Two warnings of the SAME kind, told apart only by coachId. Before
    // the warning carried one, a caller keying on `kind` would render one
    // and silently drop the other — and the dropped coach is the one about
    // to be paid twice.
    expect(warnings).toHaveLength(2);
    expect(new Set(warnings.map((w) => w.coachId))).toEqual(
      new Set([coachA.id, coachB.id]),
    );
    expect(warnings.every((w) => w.kind === "overlapping_log")).toBe(true);
    // Each sentence names its own coach, so the list reads correctly.
    expect(
      warnings.find((w) => w.coachId === coachA.id)?.message,
    ).toContain("Coach A");
    expect(
      warnings.find((w) => w.coachId === coachB.id)?.message,
    ).toContain("Coach B");
  });

  // 🔴 THE CONTROL THAT MAKES THE TEST ABOVE MEAN SOMETHING: a refused batch
  // must write NOTHING. Checking-then-writing per coach would leave the
  // clean coaches paid before the admin ever saw the warning.
  it("writes nothing at all when the batch is refused", async () => {
    const program = await createProgram();
    const coachA = await createCoach("Coach A");
    const coachB = await createCoach("Coach B");
    const day = nextDay();

    // Only coach A has something to clash with; coach B is clean.
    await logHourForCoachInternal(admin, {
      coachIds: [coachA.id],
      programId: program.id,
      startAt: at(day, "10:00"),
      endAt: at(day, "15:00"),
    });

    await expect(
      logHourForCoachInternal(admin, {
        coachIds: [coachA.id, coachB.id],
        programId: program.id,
        startAt: at(day, "10:00"),
        endAt: at(day, "14:00"),
      }),
    ).rejects.toBeInstanceOf(AdminHourEntryNotConfirmedError);

    // Coach B — the CLEAN one — must have no row from the refused batch.
    const bRows = await db
      .select()
      .from(hourLogs)
      .where(eq(hourLogs.coachId, coachB.id));
    expect(bRows).toHaveLength(0);
  });

  it("records the whole batch once confirmed", async () => {
    const program = await createProgram();
    const coachA = await createCoach("Coach A");
    const coachB = await createCoach("Coach B");
    const day = nextDay();

    await logHourForCoachInternal(admin, {
      coachIds: [coachA.id],
      programId: program.id,
      startAt: at(day, "10:00"),
      endAt: at(day, "15:00"),
    });

    const result = await logHourForCoachInternal(admin, {
      coachIds: [coachA.id, coachB.id],
      programId: program.id,
      startAt: at(day, "10:00"),
      endAt: at(day, "14:00"),
      confirmWarnings: true,
    });
    expect(result.logs).toHaveLength(2);
  });

  // A subject that does not resolve refuses the BATCH, rather than paying
  // the coaches that did resolve and leaving the absence visible nowhere.
  it("refuses the whole batch when one coach cannot be resolved", async () => {
    const program = await createProgram();
    const coachA = await createCoach("Coach A");
    const day = nextDay();

    await expect(
      logHourForCoachInternal(admin, {
        coachIds: [coachA.id, "00000000-0000-0000-0000-000000000000"],
        programId: program.id,
        startAt: at(day, "10:00"),
        endAt: at(day, "12:00"),
      }),
    ).rejects.toBeInstanceOf(HourLogSubjectNotFoundError);

    const rows = await db
      .select()
      .from(hourLogs)
      .where(eq(hourLogs.coachId, coachA.id));
    expect(rows).toHaveLength(0);
  });
});

/* ── THE SCHEDULE FOLLOWS WHAT WAS RECORDED ──────────────────────────────── */

describe("recording hours points the schedule at what happened", () => {
  // Jacob, 2026-08-25: "lets say X coach is already green on a block from 2
  // weeks ago and dad logs Y coach at that same time with the same program
  // it should just update that block on the schedule to green still but now
  // has both coaches there assigned to it."
  it("adds the coach to an existing block, leaving it green with BOTH names", async () => {
    const program = await createProgram();
    const coachA = await createCoach("Coach A");
    const coachB = await createCoach("Coach B");
    const day = nextDay();
    const startAt = at(day, "10:00");
    const endAt = at(day, "15:00");
    const now = at(day, "23:00");

    // Only coach A is scheduled, and only coach A has logged: green.
    const block = await createBlock({
      programId: program.id,
      coachIds: [coachA.id],
      startAt,
      endAt,
    });
    await logHourForCoachInternal(admin, {
      coachIds: [coachA.id],
      programId: program.id,
      startAt,
      endAt,
    });
    const green = await reconcileFromDb(block.id, now);
    expect(green.status).toBe("logged");
    expect(green.coaches).toHaveLength(1);

    // Now coach B's hours are recorded for the same window.
    const result = await logHourForCoachInternal(admin, {
      coachIds: [coachB.id],
      programId: program.id,
      startAt,
      endAt,
    });

    expect(result.schedule.kind).toBe("joined");
    if (result.schedule.kind === "joined") {
      expect(result.schedule.blockId).toBe(block.id);
      expect(result.schedule.addedCoachIds).toEqual([coachB.id]);
    }

    // The block now names both, and is STILL green.
    const after = await reconcileFromDb(block.id, now);
    expect(after.coaches).toHaveLength(2);
    expect(new Set(after.coaches.map((c) => c.coachId))).toEqual(
      new Set([coachA.id, coachB.id]),
    );
    expect(after.status).toBe("logged");
  });

  // 🔴 THE RESTRAINT THAT KEEPS THE OVER-LOGGING ALARM ALIVE. Adding a
  // PERSON is safe; moving the WINDOW is not, because `isOverLogged`
  // compares a log against its block's times — a block that reshaped itself
  // to fit the log would make that comparison zero by construction.
  it("never moves an existing block's window to match the logged hours", async () => {
    const program = await createProgram();
    const coachA = await createCoach("Coach A");
    const day = nextDay();
    const blockStart = at(day, "10:00");
    const blockEnd = at(day, "15:00");

    const block = await createBlock({
      programId: program.id,
      coachIds: [coachA.id],
      startAt: blockStart,
      endAt: blockEnd,
    });

    // Logged well outside the block's window — the over-log shape.
    await logHourForCoachInternal(admin, {
      coachIds: [coachA.id],
      programId: program.id,
      startAt: at(day, "10:00"),
      endAt: at(day, "18:00"),
    });

    const [reRead] = await db
      .select()
      .from(programScheduleBlocks)
      .where(eq(programScheduleBlocks.id, block.id));
    expect(reRead.startAt.getTime()).toBe(blockStart.getTime());
    expect(reRead.endAt.getTime()).toBe(blockEnd.getTime());
  });

  // Jacob: "if there is no block at all a new block is created based on the
  // details in the admin log button."
  it("creates a block when the work was never scheduled at all", async () => {
    const program = await createProgram();
    const coachA = await createCoach("Coach A");
    const coachB = await createCoach("Coach B");
    const day = nextDay();
    const startAt = at(day, "10:00");
    const endAt = at(day, "13:00");
    const now = at(day, "23:00");

    const result = await logHourForCoachInternal(admin, {
      coachIds: [coachA.id, coachB.id],
      programId: program.id,
      startAt,
      endAt,
    });

    expect(result.schedule.kind).toBe("created");
    if (result.schedule.kind !== "created") throw new Error("no block created");
    createdBlockIds.push(result.schedule.blockId);

    const created = await reconcileFromDb(result.schedule.blockId, now);
    // Created from the entry, so it matches it — and both coaches read as
    // logged rather than as a no-show nobody can clear.
    expect(created.coaches).toHaveLength(2);
    expect(created.status).toBe("logged");
  });

  // The headline case for admin entry is hours from a summer program that
  // has since been switched off. A retired program cannot take new schedule,
  // so the pay must still be written and the skip must be REPORTED — a
  // silent skip is a block that never appears and nobody can explain.
  it("still records the pay, and says so, when the program is retired", async () => {
    const [retired] = await db
      .insert(programs)
      .values({
        name: `Retired Multi ${uniqueSuffix()}`,
        active: false,
        defaultRatePer30MinCents: 1500,
      })
      .returning({ id: programs.id });
    createdProgramIds.push(retired.id);

    const coachA = await createCoach("Coach A");
    const day = nextDay();

    const result = await logHourForCoachInternal(admin, {
      coachIds: [coachA.id],
      programId: retired.id,
      startAt: at(day, "10:00"),
      endAt: at(day, "12:00"),
    });

    // The money is what matters and it is written.
    expect(result.logs).toHaveLength(1);
    expect(result.logs[0]!.status).toBe("posted");
    expect(result.schedule.kind).toBe("skipped");
    if (result.schedule.kind === "skipped") {
      expect(result.schedule.reason).toBe("retired_program");
      // The sentence must say the hours WERE recorded, or an admin reads a
      // skip as a failure and enters them again.
      expect(result.schedule.detail).toMatch(/recorded/i);
    }
  });

  // Re-running the same entry must not keep adding rows or churning the
  // block — the admin re-submitting after a slow page is the ordinary case.
  it("reports 'unchanged' when everyone is already on the block", async () => {
    const program = await createProgram();
    const coachA = await createCoach("Coach A");
    const day = nextDay();
    const startAt = at(day, "10:00");
    const endAt = at(day, "12:00");

    const block = await createBlock({
      programId: program.id,
      coachIds: [coachA.id],
      startAt,
      endAt,
    });

    const result = await logHourForCoachInternal(admin, {
      coachIds: [coachA.id],
      programId: program.id,
      startAt,
      endAt,
    });

    expect(result.schedule).toEqual({ kind: "unchanged", blockId: block.id });
  });
});
