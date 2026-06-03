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
  programScheduleBlocks,
  programScheduleSeries,
  programs,
  users,
} from "@/db/schema";
import {
  cancelSeriesOccurrenceInternal,
  createProgramScheduleSeriesInternal,
  editProgramScheduleSeriesInternal,
} from "@/lib/server/program-schedule-series-actions";
import {
  NotASeriesOccurrenceError,
  ProgramScheduleSeriesNotFoundError,
} from "@/lib/errors";
import { formatPfaDate } from "@/lib/timezone";
import { ensureFixtureUsers, truncateMutables, type FixtureUsers } from "./fixtures";

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
      scheduledCoachId: coach.id,
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
        scheduledCoachId: coach.id,
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
});

describe("cancelSeriesOccurrenceInternal", () => {
  it("deletes the block and records its date in the series skipDates", async () => {
    const program = await createProgram(true);
    const coach = await createCoach();
    const { series } = await trackedCreate(fixtures.admin, {
      programId: program.id,
      scheduledCoachId: coach.id,
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
      scheduledCoachId: coach1.id,
      // All weekdays so there is definitely a past + future occurrence.
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      startTime: "09:00",
      endTime: "10:00",
      startsOn: iso(past),
      endsOn: iso(future),
    });

    const before = await blocksForSeries(series.id);
    const pastBlocks = before.filter((b) => formatPfaDate(b.startAt) < today);
    const futureBlocks = before.filter((b) => formatPfaDate(b.startAt) >= today);
    expect(pastBlocks.length).toBeGreaterThan(0);
    expect(futureBlocks.length).toBeGreaterThan(0);
    const pastIds = new Set(pastBlocks.map((b) => b.id));

    // Cancel a FUTURE occurrence first so we can assert it stays skipped
    // through the edit/regenerate.
    const toCancel = futureBlocks.sort((a, b) =>
      formatPfaDate(a.startAt) < formatPfaDate(b.startAt) ? -1 : 1,
    )[1]; // second future occurrence
    const cancelledDate = formatPfaDate(toCancel.startAt);
    await cancelSeriesOccurrenceInternal(fixtures.admin, toCancel.id);

    // Edit: change coach + time, keep the same date range/weekdays.
    const { count } = await editProgramScheduleSeriesInternal(
      fixtures.admin,
      series.id,
      {
        programId: program.id,
        scheduledCoachId: coach2.id,
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

    // Future blocks regenerated: new coach2, NOT the old ids.
    const afterFuture = after.filter((b) => formatPfaDate(b.startAt) >= today);
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
          scheduledCoachId: coach.id,
          daysOfWeek: [1],
          startTime: "09:00",
          endTime: "10:00",
          startsOn: FUTURE_START,
          endsOn: FUTURE_END,
        },
      ),
    ).rejects.toBeInstanceOf(ProgramScheduleSeriesNotFoundError);
  });
});
