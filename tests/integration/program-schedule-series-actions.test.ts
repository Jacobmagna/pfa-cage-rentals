// Integration tests for src/lib/server/program-schedule-series-actions.ts.
// Hits the real Neon dev branch (ep-dawn-forest). Same direct-internal
// pattern as the other suites — call the *Internal exports with a
// synthetic admin actor; the public "use server" wrappers add only
// requireRole + revalidatePath.
//
// truncateMutables() does NOT touch programs / users /
// program_schedule_blocks / program_schedule_series, so each test makes
// its own program + coach with unique suffixes and cleans up the series
// it creates in afterEach (deleting a series CASCADEs its blocks).
//
// Requires migration 0021 applied to the dev branch.

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
  blockedTimes,
  programScheduleBlockCoaches,
  programScheduleBlocks,
  programScheduleSeries,
  programScheduleSeriesCoaches,
  programs,
  users,
} from "@/db/schema";
import {
  cancelSeriesOccurrenceInternal,
  createProgramScheduleSeriesInternal,
  editProgramScheduleSeriesInternal,
} from "@/lib/server/program-schedule-series-actions";
import {
  BlockOverlapError,
  NotASeriesOccurrenceError,
  ProgramScheduleSeriesNotFoundError,
} from "@/lib/errors";
import { formatPfaDate, pfaWallClockToUtc } from "@/lib/timezone";
import {
  ensureFixtureUsers,
  getSeededResources,
  truncateMutables,
  type FixtureUsers,
} from "./fixtures";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

let fixtures: FixtureUsers;

const createdSeriesIds: string[] = [];
const createdProgramIds: string[] = [];
const createdUserIds: string[] = [];

beforeAll(async () => {
  fixtures = await ensureFixtureUsers();
});

beforeEach(async () => {
  await truncateMutables();
});

afterEach(async () => {
  if (createdSeriesIds.length > 0) {
    // Deleting the series CASCADEs its materialized blocks.
    await db
      .delete(programScheduleSeries)
      .where(inArray(programScheduleSeries.id, createdSeriesIds));
    createdSeriesIds.length = 0;
  }
});

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createProgram(active: boolean): Promise<{ id: string; name: string }> {
  const name = `ProgSeries Test Program ${uniqueSuffix()}`;
  const [row] = await db
    .insert(programs)
    .values({ name, active })
    .returning({ id: programs.id, name: programs.name });
  createdProgramIds.push(row.id);
  return row;
}

async function createCoach(): Promise<{ id: string }> {
  const [row] = await db
    .insert(users)
    .values({
      email: `progseries-${uniqueSuffix()}@test.invalid`,
      name: "ProgSeries Coach",
      role: "coach",
    })
    .returning({ id: users.id });
  createdUserIds.push(row.id);
  return row;
}

async function trackedCreate(
  ...args: Parameters<typeof createProgramScheduleSeriesInternal>
) {
  const result = await createProgramScheduleSeriesInternal(...args);
  createdSeriesIds.push(result.series.id);
  return result;
}

async function blocksForSeries(seriesId: string) {
  return db
    .select()
    .from(programScheduleBlocks)
    .where(eq(programScheduleBlocks.seriesId, seriesId));
}

// QA10 W3.2: the coach ids in a series' / block's join set.
async function seriesCoachIds(seriesId: string): Promise<string[]> {
  const rows = await db
    .select({ coachId: programScheduleSeriesCoaches.coachId })
    .from(programScheduleSeriesCoaches)
    .where(eq(programScheduleSeriesCoaches.seriesId, seriesId));
  return rows.map((r) => r.coachId);
}
async function blockCoachIds(blockId: string): Promise<string[]> {
  const rows = await db
    .select({ coachId: programScheduleBlockCoaches.coachId })
    .from(programScheduleBlockCoaches)
    .where(eq(programScheduleBlockCoaches.blockId, blockId));
  return rows.map((r) => r.coachId);
}

// A far-FUTURE Monday so every generated occurrence is "future" relative
// to the action's `today`, keeping edit/cancel deterministic. 2099-01-05
// is a Monday.
const FUTURE_START = "2099-01-05";
const FUTURE_END = "2099-02-01"; // inclusive → 4 Mondays: 05,12,19,26

describe("createProgramScheduleSeriesInternal", () => {
  it("creates a series and materializes one block per occurrence with seriesId set", async () => {
    const program = await createProgram(true);
    const coach = await createCoach();

    const { series, count } = await trackedCreate(fixtures.admin, {
      programId: program.id,
      scheduledCoachIds: [coach.id],
      daysOfWeek: [1],
      startTime: "09:00",
      endTime: "10:00",
      startsOn: FUTURE_START,
      endsOn: FUTURE_END,
      note: "recurring clinic",
    });

    expect(series.id).toBeTruthy();
    expect(count).toBe(4);

    const blocks = await blocksForSeries(series.id);
    expect(blocks).toHaveLength(4);
    for (const b of blocks) {
      expect(b.seriesId).toBe(series.id);
      expect(b.programId).toBe(program.id);
      expect(b.scheduledCoachId).toBe(coach.id);
      expect(b.note).toBe("recurring clinic");
      expect(b.createdBy).toBe(fixtures.admin.id);
    }
    // Dates land on the 4 Mondays.
    const dates = blocks.map((b) => formatPfaDate(b.startAt)).sort();
    expect(dates).toEqual([
      "2099-01-05",
      "2099-01-12",
      "2099-01-19",
      "2099-01-26",
    ]);
  });

  it("rejects an over-cap recurrence and writes no series/blocks", async () => {
    const program = await createProgram(true);
    const coach = await createCoach();
    await expect(
      createProgramScheduleSeriesInternal(fixtures.admin, {
        programId: program.id,
        scheduledCoachIds: [coach.id],
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        startTime: "09:00",
        endTime: "10:00",
        startsOn: "2099-01-01",
        endsOn: "2100-12-31",
      }),
    ).rejects.toThrow();

    const series = await db
      .select()
      .from(programScheduleSeries)
      .where(eq(programScheduleSeries.programId, program.id));
    expect(series).toHaveLength(0);
  });

  // QA10 W3.2: creating with 2 coaches writes 2 series-coach rows + 2 coach
  // rows per materialized occurrence block; primary = [0].
  it("writes the full coach set on the series + every occurrence block", async () => {
    const program = await createProgram(true);
    const coach1 = await createCoach();
    const coach2 = await createCoach();

    const { series } = await trackedCreate(fixtures.admin, {
      programId: program.id,
      scheduledCoachIds: [coach1.id, coach2.id],
      daysOfWeek: [1],
      startTime: "09:00",
      endTime: "10:00",
      startsOn: FUTURE_START,
      endsOn: FUTURE_END,
    });

    expect(series.scheduledCoachId).toBe(coach1.id); // primary = [0]
    expect((await seriesCoachIds(series.id)).sort()).toEqual(
      [coach1.id, coach2.id].sort(),
    );

    const blocks = await blocksForSeries(series.id);
    expect(blocks.length).toBe(4);
    for (const b of blocks) {
      expect(b.scheduledCoachId).toBe(coach1.id);
      expect((await blockCoachIds(b.id)).sort()).toEqual(
        [coach1.id, coach2.id].sort(),
      );
    }
  });
});

describe("cancelSeriesOccurrenceInternal", () => {
  it("deletes the block and records its date in the series skipDates", async () => {
    const program = await createProgram(true);
    const coach = await createCoach();
    const { series } = await trackedCreate(fixtures.admin, {
      programId: program.id,
      scheduledCoachIds: [coach.id],
      daysOfWeek: [1],
      startTime: "09:00",
      endTime: "10:00",
      startsOn: FUTURE_START,
      endsOn: FUTURE_END,
    });

    const blocks = await blocksForSeries(series.id);
    const target = blocks.find(
      (b) => formatPfaDate(b.startAt) === "2099-01-12",
    )!;
    expect(target).toBeDefined();

    const result = await cancelSeriesOccurrenceInternal(
      fixtures.admin,
      target.id,
    );
    expect(result.cancelledDate).toBe("2099-01-12");

    const remaining = await blocksForSeries(series.id);
    expect(remaining).toHaveLength(3);
    expect(remaining.map((b) => formatPfaDate(b.startAt)).sort()).toEqual([
      "2099-01-05",
      "2099-01-19",
      "2099-01-26",
    ]);

    const [row] = await db
      .select()
      .from(programScheduleSeries)
      .where(eq(programScheduleSeries.id, series.id));
    expect(row.skipDates).toContain("2099-01-12");
  });

  it("rejects cancelling a one-off (non-series) block", async () => {
    const program = await createProgram(true);
    const coach = await createCoach();
    // Insert a block with no seriesId directly.
    const [oneOff] = await db
      .insert(programScheduleBlocks)
      .values({
        programId: program.id,
        scheduledCoachId: coach.id,
        startAt: new Date("2099-01-05T14:00:00Z"),
        endAt: new Date("2099-01-05T15:00:00Z"),
        createdBy: fixtures.admin.id,
      })
      .returning();

    await expect(
      cancelSeriesOccurrenceInternal(fixtures.admin, oneOff.id),
    ).rejects.toBeInstanceOf(NotASeriesOccurrenceError);

    // Cleanup the one-off (not series-tracked).
    await db
      .delete(programScheduleBlocks)
      .where(eq(programScheduleBlocks.id, oneOff.id));
  });
});

describe("editProgramScheduleSeriesInternal", () => {
  it("regenerates future blocks (new coach/time), leaves past blocks, keeps skipped dates skipped", async () => {
    const program = await createProgram(true);
    const coach1 = await createCoach();
    const coach2 = await createCoach();

    // Series spanning PAST → FUTURE so we can assert past blocks survive.
    // Anchor relative to today's PFA date.
    const today = formatPfaDate(new Date());
    const [ty, tm, td] = today.split("-").map(Number);
    // Start 14 days ago, end 21 days ahead, Mondays only — guarantees at
    // least one past and one future Monday around "today".
    const past = new Date(Date.UTC(ty, tm - 1, td - 28));
    const future = new Date(Date.UTC(ty, tm - 1, td + 28));
    const iso = (d: Date) =>
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;

    const { series } = await trackedCreate(fixtures.admin, {
      programId: program.id,
      scheduledCoachIds: [coach1.id],
      // All weekdays so there is definitely a past + future occurrence.
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      startTime: "09:00",
      endTime: "10:00",
      startsOn: iso(past),
      endsOn: iso(future),
    });

    // Approved boundary: occurrences that have ALREADY STARTED (startAt <
    // now, including ones earlier today) are kept as history; only genuinely
    // future ones (startAt >= now) regenerate. Classify by the instant the
    // edit will run against, NOT by PFA calendar date, so today's earlier
    // occurrence counts as past.
    const now = new Date();
    const before = await blocksForSeries(series.id);
    const pastBlocks = before.filter((b) => b.startAt.getTime() < now.getTime());
    const futureBlocks = before.filter(
      (b) => b.startAt.getTime() >= now.getTime(),
    );
    expect(pastBlocks.length).toBeGreaterThan(0);
    expect(futureBlocks.length).toBeGreaterThan(0);
    const pastIds = new Set(pastBlocks.map((b) => b.id));

    // Cancel a FUTURE occurrence first so we can assert it stays skipped
    // through the edit/regenerate.
    const toCancel = futureBlocks.sort((a, b) =>
      a.startAt.getTime() - b.startAt.getTime(),
    )[1]; // second future occurrence
    const cancelledDate = formatPfaDate(toCancel.startAt);
    await cancelSeriesOccurrenceInternal(fixtures.admin, toCancel.id);

    // Edit: change coach + time, keep the same date range/weekdays.
    const { count } = await editProgramScheduleSeriesInternal(
      fixtures.admin,
      series.id,
      {
        programId: program.id,
        scheduledCoachIds: [coach2.id],
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        startTime: "15:00",
        endTime: "16:00",
        startsOn: iso(past),
        endsOn: iso(future),
      },
    );
    expect(count).toBeGreaterThan(0);

    const after = await blocksForSeries(series.id);

    // Past blocks untouched: same ids, original coach1, original 09:00.
    const afterPast = after.filter((b) => pastIds.has(b.id));
    expect(afterPast.length).toBe(pastBlocks.length);
    for (const b of afterPast) {
      expect(b.scheduledCoachId).toBe(coach1.id);
      expect(b.startAt.getTime()).toBe(
        before.find((x) => x.id === b.id)!.startAt.getTime(),
      );
    }

    // Future blocks regenerated: new coach2, NOT the old ids. Classify by
    // the same `now` instant used to split before the edit.
    const afterFuture = after.filter(
      (b) => b.startAt.getTime() >= now.getTime(),
    );
    expect(afterFuture.length).toBeGreaterThan(0);
    for (const b of afterFuture) {
      expect(b.scheduledCoachId).toBe(coach2.id);
      expect(pastIds.has(b.id)).toBe(false);
    }

    // The cancelled date stays skipped — no regenerated block on it.
    expect(
      afterFuture.some((b) => formatPfaDate(b.startAt) === cancelledDate),
    ).toBe(false);

    const [seriesRow] = await db
      .select()
      .from(programScheduleSeries)
      .where(eq(programScheduleSeries.id, series.id));
    expect(seriesRow.scheduledCoachId).toBe(coach2.id);
    expect(seriesRow.startTime).toBe("15:00");
    expect(seriesRow.skipDates).toContain(cancelledDate);
  });

  it("rejects editing a non-existent series (ProgramScheduleSeriesNotFoundError)", async () => {
    const program = await createProgram(true);
    const coach = await createCoach();
    await expect(
      editProgramScheduleSeriesInternal(
        fixtures.admin,
        "00000000-0000-0000-0000-000000000000",
        {
          programId: program.id,
          scheduledCoachIds: [coach.id],
          daysOfWeek: [1],
          startTime: "09:00",
          endTime: "10:00",
          startsOn: FUTURE_START,
          endsOn: FUTURE_END,
        },
      ),
    ).rejects.toBeInstanceOf(ProgramScheduleSeriesNotFoundError);
  });

  // QA10 W3.2: editing to a different coach SET replaces the series-coach
  // rows and re-applies the new set to FUTURE blocks only; past blocks keep
  // their original coach rows.
  it("replaces the coach set on the series + future blocks; past blocks keep theirs", async () => {
    const program = await createProgram(true);
    const coach1 = await createCoach();
    const coach2 = await createCoach();
    const coach3 = await createCoach();

    const today = formatPfaDate(new Date());
    const [ty, tm, td] = today.split("-").map(Number);
    const past = new Date(Date.UTC(ty, tm - 1, td - 28));
    const future = new Date(Date.UTC(ty, tm - 1, td + 28));
    const iso = (d: Date) =>
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;

    const { series } = await trackedCreate(fixtures.admin, {
      programId: program.id,
      scheduledCoachIds: [coach1.id, coach2.id],
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      startTime: "09:00",
      endTime: "10:00",
      startsOn: iso(past),
      endsOn: iso(future),
    });

    // Approved boundary: split past/future by the current instant (startAt
    // < now = history), not by PFA date, so today's earlier occurrence is
    // kept as history rather than regenerated.
    const now = new Date();
    const before = await blocksForSeries(series.id);
    const pastBlock = before.find(
      (b) => b.startAt.getTime() < now.getTime(),
    )!;
    expect(pastBlock).toBeDefined();
    const pastCoachesBefore = (await blockCoachIds(pastBlock.id)).sort();

    // Edit to a DIFFERENT coach set.
    await editProgramScheduleSeriesInternal(fixtures.admin, series.id, {
      programId: program.id,
      scheduledCoachIds: [coach3.id, coach1.id],
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      startTime: "09:00",
      endTime: "10:00",
      startsOn: iso(past),
      endsOn: iso(future),
    });

    // Series-coach rows replaced.
    expect((await seriesCoachIds(series.id)).sort()).toEqual(
      [coach1.id, coach3.id].sort(),
    );

    const after = await blocksForSeries(series.id);
    // Past block untouched: same coach rows as before the edit.
    const afterPast = after.find((b) => b.id === pastBlock.id)!;
    expect((await blockCoachIds(afterPast.id)).sort()).toEqual(
      pastCoachesBefore,
    );

    // Future blocks carry the NEW set.
    const futureBlocks = after.filter(
      (b) => b.startAt.getTime() >= now.getTime(),
    );
    expect(futureBlocks.length).toBeGreaterThan(0);
    for (const b of futureBlocks) {
      expect(b.scheduledCoachId).toBe(coach3.id); // new primary
      expect((await blockCoachIds(b.id)).sort()).toEqual(
        [coach1.id, coach3.id].sort(),
      );
    }
  });
});

// QA10 W3.3: a recurring series occupies cage resources — one linked
// blocked_time per occurrence; regenerate replaces FUTURE ones.
describe("series occupies cage resources (W3.3)", () => {
  async function linkedForSeries(seriesId: string) {
    return db
      .select({
        id: blockedTimes.id,
        resourceId: blockedTimes.resourceId,
        reason: blockedTimes.reason,
        startAt: blockedTimes.startAt,
        programScheduleBlockId: blockedTimes.programScheduleBlockId,
      })
      .from(blockedTimes)
      .innerJoin(
        programScheduleBlocks,
        eq(blockedTimes.programScheduleBlockId, programScheduleBlocks.id),
      )
      .where(eq(programScheduleBlocks.seriesId, seriesId));
  }

  it("create with a resource writes one linked blocked_time per occurrence", async () => {
    const program = await createProgram(true);
    const coach = await createCoach();
    const { cage1 } = await getSeededResources();

    const { series, count } = await trackedCreate(fixtures.admin, {
      programId: program.id,
      scheduledCoachIds: [coach.id],
      resourceIds: [cage1.id],
      daysOfWeek: [1],
      startTime: "09:00",
      endTime: "10:00",
      startsOn: FUTURE_START,
      endsOn: FUTURE_END,
    });
    expect(count).toBe(4);

    const linked = await linkedForSeries(series.id);
    expect(linked).toHaveLength(4);
    for (const l of linked) {
      expect(l.resourceId).toBe(cage1.id);
      expect(l.reason).toBe(`Program: ${program.name}`);
      expect(l.programScheduleBlockId).toBeTruthy();
    }
    // One per occurrence block.
    const blocks = await blocksForSeries(series.id);
    expect(new Set(linked.map((l) => l.programScheduleBlockId)).size).toBe(
      blocks.length,
    );
  });

  it("regenerate replaces FUTURE linked blocks; past ones untouched", async () => {
    const program = await createProgram(true);
    const coach = await createCoach();
    const { cage1, cage2 } = await getSeededResources();

    const today = formatPfaDate(new Date());
    const [ty, tm, td] = today.split("-").map(Number);
    const past = new Date(Date.UTC(ty, tm - 1, td - 28));
    const future = new Date(Date.UTC(ty, tm - 1, td + 28));
    const iso = (d: Date) =>
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;

    const { series } = await trackedCreate(fixtures.admin, {
      programId: program.id,
      scheduledCoachIds: [coach.id],
      resourceIds: [cage1.id],
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      startTime: "09:00",
      endTime: "10:00",
      startsOn: iso(past),
      endsOn: iso(future),
    });

    // Approved boundary: linked rows whose occupancy has already started
    // (startAt < now) are history and untouched; only future ones (>= now)
    // regenerate. Split by instant, not PFA date, so today's earlier
    // occupancy counts as past.
    const now = new Date();
    const before = await linkedForSeries(series.id);
    const pastLinked = before.filter(
      (l) => l.startAt.getTime() < now.getTime(),
    );
    expect(pastLinked.length).toBeGreaterThan(0);
    const pastLinkedIds = new Set(pastLinked.map((l) => l.id));

    // Edit to a DIFFERENT resource, same range.
    await editProgramScheduleSeriesInternal(fixtures.admin, series.id, {
      programId: program.id,
      scheduledCoachIds: [coach.id],
      resourceIds: [cage2.id],
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      startTime: "09:00",
      endTime: "10:00",
      startsOn: iso(past),
      endsOn: iso(future),
    });

    const after = await linkedForSeries(series.id);
    // Past linked rows survive unchanged (still cage1, same ids).
    const afterPast = after.filter((l) => pastLinkedIds.has(l.id));
    expect(afterPast.length).toBe(pastLinked.length);
    for (const l of afterPast) {
      expect(l.resourceId).toBe(cage1.id);
    }
    // Future linked rows now point at cage2.
    const afterFuture = after.filter(
      (l) => l.startAt.getTime() >= now.getTime(),
    );
    expect(afterFuture.length).toBeGreaterThan(0);
    for (const l of afterFuture) {
      expect(l.resourceId).toBe(cage2.id);
      expect(pastLinkedIds.has(l.id)).toBe(false);
    }
  });

  it("edit colliding with an UNRELATED manual block throws and leaves future occurrences intact", async () => {
    const program = await createProgram(true);
    const coach = await createCoach();
    const { cage1, cage2 } = await getSeededResources();

    // Series on cage1, Mondays 09:00–10:00.
    const { series } = await trackedCreate(fixtures.admin, {
      programId: program.id,
      scheduledCoachIds: [coach.id],
      resourceIds: [cage1.id],
      daysOfWeek: [1],
      startTime: "09:00",
      endTime: "10:00",
      startsOn: FUTURE_START,
      endsOn: FUTURE_END,
    });

    const blocksBefore = await blocksForSeries(series.id);
    const linkedBefore = await linkedForSeries(series.id);
    expect(blocksBefore.length).toBe(4);

    // A manually-created (NULL-linked) block on cage2 at the first future
    // Monday's window — collides with where the edit wants to move the series.
    await db.insert(blockedTimes).values({
      resourceId: cage2.id,
      startAt: pfaWallClockToUtc(FUTURE_START, "09:00"),
      endAt: pfaWallClockToUtc(FUTURE_START, "10:00"),
      reason: "Maintenance",
      createdBy: fixtures.admin.id,
    });

    // Editing the series onto cage2 must throw the friendly conflict (Fix 1:
    // the NULL-linked manual block is still detected) BEFORE any write.
    await expect(
      editProgramScheduleSeriesInternal(fixtures.admin, series.id, {
        programId: program.id,
        scheduledCoachIds: [coach.id],
        resourceIds: [cage2.id],
        daysOfWeek: [1],
        startTime: "09:00",
        endTime: "10:00",
        startsOn: FUTURE_START,
        endsOn: FUTURE_END,
      }),
    ).rejects.toBeInstanceOf(BlockOverlapError);

    // Fix 2: nothing was mutated — the series' future occurrences and their
    // linked occupancy blocks are unchanged (count + ids intact, still cage1).
    const blocksAfter = await blocksForSeries(series.id);
    expect(blocksAfter.length).toBe(blocksBefore.length);
    expect(new Set(blocksAfter.map((b) => b.id))).toEqual(
      new Set(blocksBefore.map((b) => b.id)),
    );
    const linkedAfter = await linkedForSeries(series.id);
    expect(linkedAfter.length).toBe(linkedBefore.length);
    for (const l of linkedAfter) {
      expect(l.resourceId).toBe(cage1.id);
    }
  });
});
