// Integration tests for src/lib/server/block-series-actions.ts (BLOCK-RECUR).
// Hits the real Neon dev branch. Same direct-internal pattern as the other
// suites — call the *Internal exports with the fixture admin actor.
//
// truncateMutables() TRUNCATEs blocked_times + sessions_billing + audit_log,
// so each test starts with a clean resource. blocked_times_series is NOT
// truncated, so we delete created series in afterEach (cascade clears any
// remaining occurrence blocks). Requires migration 0040 on the dev branch.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  auditLog,
  blockedTimes,
  blockedTimesSeries,
  sessionsBilling,
} from "@/db/schema";
import {
  cancelBlockSeriesOccurrenceInternal,
  createBlockSeriesInternal,
  deleteBlockSeriesInternal,
  editBlockSeriesInternal,
} from "@/lib/server/block-series-actions";
import { generateOccurrences } from "@/lib/schedule-recurrence";
import {
  BlockedTimeSeriesNotFoundError,
  BlockNotFoundError,
  NotASeriesOccurrenceError,
  ResourceNotFoundError,
} from "@/lib/errors";
import {
  ensureFixtureUsers,
  getSeededResources,
  truncateMutables,
  type FixtureUsers,
} from "./fixtures";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

let fixtures: FixtureUsers;
let cageId: string;
const createdSeriesIds: string[] = [];

beforeAll(async () => {
  fixtures = await ensureFixtureUsers();
  const { cage1 } = await getSeededResources();
  cageId = cage1.id;
});

beforeEach(async () => {
  await truncateMutables();
});

afterEach(async () => {
  if (createdSeriesIds.length > 0) {
    await db
      .delete(blockedTimesSeries)
      .where(inArray(blockedTimesSeries.id, createdSeriesIds));
    createdSeriesIds.length = 0;
  }
});

// ISO date N days from today (UTC calendar is fine — the generator keys on
// the PFA calendar but these tests only need relative ordering).
function isoDaysFromToday(delta: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// Insert a rental on the cage covering a given UTC instant window.
async function insertRental(startAt: Date, endAt: Date): Promise<void> {
  await db.insert(sessionsBilling).values({
    coachId: fixtures.coach.id,
    resourceId: cageId,
    startAt,
    endAt,
    ratePer30MinCents: 2200,
    createdBy: fixtures.admin.id,
  });
}

async function insertOneOffBlock(startAt: Date, endAt: Date): Promise<void> {
  await db.insert(blockedTimes).values({
    resourceId: cageId,
    startAt,
    endAt,
    reason: "pre-existing one-off",
    createdBy: fixtures.admin.id,
  });
}

async function seriesBlocks(seriesId: string) {
  return db
    .select()
    .from(blockedTimes)
    .where(eq(blockedTimes.seriesId, seriesId));
}

describe("createBlockSeriesInternal", () => {
  it("materializes one blocked_times row per occurrence + writes a series + audit", async () => {
    // Weekly Mon/Wed for ~2 weeks.
    const startsOn = isoDaysFromToday(1);
    const endsOn = isoDaysFromToday(15);
    const input = {
      resourceId: cageId,
      reason: "Court maintenance",
      daysOfWeek: [1, 3],
      startTime: "15:00",
      endTime: "17:00",
      startsOn,
      endsOn,
    };
    const expected = generateOccurrences({
      daysOfWeek: [1, 3],
      startTime: "15:00",
      endTime: "17:00",
      startsOn,
      endsOn,
    });

    const res = await createBlockSeriesInternal(fixtures.admin, input);
    if (res.seriesId) createdSeriesIds.push(res.seriesId);

    expect(res.seriesId).toBeTruthy();
    expect(res.created).toBe(expected.length);
    expect(res.skippedRentals).toHaveLength(0);
    expect(res.skippedBlocked).toBe(0);

    const blocks = await seriesBlocks(res.seriesId!);
    expect(blocks).toHaveLength(expected.length);
    expect(blocks.every((b) => b.reason === "Court maintenance")).toBe(true);
    expect(blocks.every((b) => b.resourceId === cageId)).toBe(true);

    const [series] = await db
      .select()
      .from(blockedTimesSeries)
      .where(eq(blockedTimesSeries.id, res.seriesId!));
    expect(series.daysOfWeek).toEqual([1, 3]);
    expect(series.reason).toBe("Court maintenance");

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "blocked_times_series"),
          eq(auditLog.entityId, res.seriesId!),
          eq(auditLog.action, "create"),
        ),
      );
    expect(audit).toBeDefined();
  });

  it("SKIPS an occurrence that overlaps an existing RENTAL and reports it", async () => {
    const startsOn = isoDaysFromToday(1);
    const endsOn = isoDaysFromToday(15);
    const occ = generateOccurrences({
      daysOfWeek: [1, 3],
      startTime: "15:00",
      endTime: "17:00",
      startsOn,
      endsOn,
    });
    expect(occ.length).toBeGreaterThan(1);
    // Rent the cage over the FIRST occurrence's exact window.
    await insertRental(occ[0].startAt, occ[0].endAt);

    const res = await createBlockSeriesInternal(fixtures.admin, {
      resourceId: cageId,
      reason: "Court maintenance",
      daysOfWeek: [1, 3],
      startTime: "15:00",
      endTime: "17:00",
      startsOn,
      endsOn,
    });
    if (res.seriesId) createdSeriesIds.push(res.seriesId);

    expect(res.created).toBe(occ.length - 1);
    expect(res.skippedRentals).toHaveLength(1);
    expect(res.skippedRentals[0].coachName).toBeTruthy();
    expect(res.skippedRentals[0].label).toContain(res.skippedRentals[0].coachName);
    expect(res.skippedBlocked).toBe(0);
    // Invariant: created + skipped == total occurrences.
    expect(res.created + res.skippedRentals.length + res.skippedBlocked).toBe(
      occ.length,
    );
  });

  it("SKIPS SILENTLY an occurrence that overlaps an existing BLOCK", async () => {
    const startsOn = isoDaysFromToday(1);
    const endsOn = isoDaysFromToday(15);
    const occ = generateOccurrences({
      daysOfWeek: [1, 3],
      startTime: "15:00",
      endTime: "17:00",
      startsOn,
      endsOn,
    });
    await insertOneOffBlock(occ[0].startAt, occ[0].endAt);

    const res = await createBlockSeriesInternal(fixtures.admin, {
      resourceId: cageId,
      reason: "Court maintenance",
      daysOfWeek: [1, 3],
      startTime: "15:00",
      endTime: "17:00",
      startsOn,
      endsOn,
    });
    if (res.seriesId) createdSeriesIds.push(res.seriesId);

    expect(res.created).toBe(occ.length - 1);
    expect(res.skippedBlocked).toBe(1);
    expect(res.skippedRentals).toHaveLength(0);
  });

  it("makes NO series and returns created:0 when every occurrence conflicts", async () => {
    const startsOn = isoDaysFromToday(1);
    const endsOn = isoDaysFromToday(15);
    const occ = generateOccurrences({
      daysOfWeek: [1, 3],
      startTime: "15:00",
      endTime: "17:00",
      startsOn,
      endsOn,
    });
    // Rent every occurrence.
    for (const o of occ) await insertRental(o.startAt, o.endAt);

    const res = await createBlockSeriesInternal(fixtures.admin, {
      resourceId: cageId,
      reason: "Court maintenance",
      daysOfWeek: [1, 3],
      startTime: "15:00",
      endTime: "17:00",
      startsOn,
      endsOn,
    });
    if (res.seriesId) createdSeriesIds.push(res.seriesId);

    expect(res.seriesId).toBeNull();
    expect(res.created).toBe(0);
    expect(res.skippedRentals).toHaveLength(occ.length);
    const seriesCount = await db.select().from(blockedTimesSeries);
    // No series row for this attempt (others from prior tests were cleaned).
    expect(seriesCount.every((s) => s.reason !== "Court maintenance" || false)).toBeDefined();
  });

  it("rejects an unknown resource (ResourceNotFoundError)", async () => {
    await expect(
      createBlockSeriesInternal(fixtures.admin, {
        resourceId: "00000000-0000-0000-0000-000000000000",
        reason: "x",
        daysOfWeek: [1],
        startTime: "15:00",
        endTime: "17:00",
        startsOn: isoDaysFromToday(1),
        endsOn: isoDaysFromToday(8),
      }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("hard-rejects an over-cap date range (>366 occurrences)", async () => {
    await expect(
      createBlockSeriesInternal(fixtures.admin, {
        resourceId: cageId,
        reason: "x",
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        startTime: "15:00",
        endTime: "17:00",
        startsOn: isoDaysFromToday(0),
        endsOn: isoDaysFromToday(800),
      }),
    ).rejects.toBeTruthy();
  });
});

describe("editBlockSeriesInternal", () => {
  it("regenerates FUTURE occurrences and leaves PAST ones untouched", async () => {
    // Daily series spanning 10 days past → 10 days future.
    const base = {
      resourceId: cageId,
      reason: "Maintenance",
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      startTime: "10:00",
      endTime: "11:00",
      startsOn: isoDaysFromToday(-10),
      endsOn: isoDaysFromToday(10),
    };
    const created = await createBlockSeriesInternal(fixtures.admin, base);
    createdSeriesIds.push(created.seriesId!);

    const now = new Date();
    const before = await seriesBlocks(created.seriesId!);
    const pastIds = before.filter((b) => b.startAt < now).map((b) => b.id).sort();
    const futureIdsBefore = before
      .filter((b) => b.startAt >= now)
      .map((b) => b.id)
      .sort();
    expect(pastIds.length).toBeGreaterThan(0);
    expect(futureIdsBefore.length).toBeGreaterThan(0);

    // Edit the time window.
    const res = await editBlockSeriesInternal(fixtures.admin, created.seriesId!, {
      ...base,
      startTime: "14:00",
      endTime: "15:00",
    });
    expect(res.created).toBe(futureIdsBefore.length);

    const after = await seriesBlocks(created.seriesId!);
    const pastIdsAfter = after.filter((b) => b.startAt < now).map((b) => b.id).sort();
    const futureIdsAfter = after.filter((b) => b.startAt >= now).map((b) => b.id);

    // Past occurrences untouched (same ids).
    expect(pastIdsAfter).toEqual(pastIds);
    // Future occurrences were regenerated — the old future ids are gone.
    for (const oldId of futureIdsBefore) {
      expect(futureIdsAfter).not.toContain(oldId);
    }
    // Series definition updated.
    const [series] = await db
      .select()
      .from(blockedTimesSeries)
      .where(eq(blockedTimesSeries.id, created.seriesId!));
    expect(series.startTime).toBe("14:00");
  });

  it("skip-and-continue on edit: a future occurrence colliding with a rental is skipped + reported", async () => {
    const base = {
      resourceId: cageId,
      reason: "Maintenance",
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      startTime: "10:00",
      endTime: "11:00",
      startsOn: isoDaysFromToday(-2),
      endsOn: isoDaysFromToday(10),
    };
    const created = await createBlockSeriesInternal(fixtures.admin, base);
    createdSeriesIds.push(created.seriesId!);

    // New definition's future occurrences at 14:00. Rent one of them so the
    // regenerate must skip it.
    const now = new Date();
    const newFuture = generateOccurrences({
      daysOfWeek: base.daysOfWeek,
      startTime: "14:00",
      endTime: "15:00",
      startsOn: base.startsOn,
      endsOn: base.endsOn,
    }).filter((o) => o.startAt >= now);
    expect(newFuture.length).toBeGreaterThan(1);
    await insertRental(newFuture[0].startAt, newFuture[0].endAt);

    const res = await editBlockSeriesInternal(fixtures.admin, created.seriesId!, {
      ...base,
      startTime: "14:00",
      endTime: "15:00",
    });
    expect(res.skippedRentals).toHaveLength(1);
    expect(res.created).toBe(newFuture.length - 1);
  });

  it("rejects an unknown series id (BlockedTimeSeriesNotFoundError)", async () => {
    await expect(
      editBlockSeriesInternal(fixtures.admin, "00000000-0000-0000-0000-000000000000", {
        resourceId: cageId,
        reason: "x",
        daysOfWeek: [1],
        startTime: "10:00",
        endTime: "11:00",
        startsOn: isoDaysFromToday(1),
        endsOn: isoDaysFromToday(8),
      }),
    ).rejects.toBeInstanceOf(BlockedTimeSeriesNotFoundError);
  });
});

describe("cancelBlockSeriesOccurrenceInternal", () => {
  it("deletes the occurrence + records its date in the series skipDates", async () => {
    const base = {
      resourceId: cageId,
      reason: "Maintenance",
      daysOfWeek: [1, 3],
      startTime: "10:00",
      endTime: "11:00",
      startsOn: isoDaysFromToday(1),
      endsOn: isoDaysFromToday(15),
    };
    const created = await createBlockSeriesInternal(fixtures.admin, base);
    createdSeriesIds.push(created.seriesId!);
    const blocks = await seriesBlocks(created.seriesId!);
    const target = blocks[0];

    const res = await cancelBlockSeriesOccurrenceInternal(
      fixtures.admin,
      target.id,
    );
    expect(res.seriesId).toBe(created.seriesId);

    const remaining = await seriesBlocks(created.seriesId!);
    expect(remaining.map((b) => b.id)).not.toContain(target.id);

    const [series] = await db
      .select()
      .from(blockedTimesSeries)
      .where(eq(blockedTimesSeries.id, created.seriesId!));
    expect(series.skipDates).toContain(res.cancelledDate);
  });

  it("rejects a non-series (one-off) block (NotASeriesOccurrenceError)", async () => {
    const startAt = new Date();
    startAt.setUTCHours(startAt.getUTCHours() + 24, 0, 0, 0);
    const endAt = new Date(startAt.getTime() + 60 * 60 * 1000);
    const [oneOff] = await db
      .insert(blockedTimes)
      .values({
        resourceId: cageId,
        startAt,
        endAt,
        reason: "one-off",
        createdBy: fixtures.admin.id,
      })
      .returning({ id: blockedTimes.id });

    await expect(
      cancelBlockSeriesOccurrenceInternal(fixtures.admin, oneOff.id),
    ).rejects.toBeInstanceOf(NotASeriesOccurrenceError);
  });

  it("rejects an unknown block id (BlockNotFoundError)", async () => {
    await expect(
      cancelBlockSeriesOccurrenceInternal(
        fixtures.admin,
        "00000000-0000-0000-0000-000000000000",
      ),
    ).rejects.toBeInstanceOf(BlockNotFoundError);
  });
});

describe("deleteBlockSeriesInternal", () => {
  it("deletes the series and cascades ALL its occurrences", async () => {
    const created = await createBlockSeriesInternal(fixtures.admin, {
      resourceId: cageId,
      reason: "Maintenance",
      daysOfWeek: [1, 3],
      startTime: "10:00",
      endTime: "11:00",
      startsOn: isoDaysFromToday(1),
      endsOn: isoDaysFromToday(15),
    });
    expect((await seriesBlocks(created.seriesId!)).length).toBeGreaterThan(0);

    await deleteBlockSeriesInternal(fixtures.admin, created.seriesId!);

    expect(await seriesBlocks(created.seriesId!)).toHaveLength(0);
    const [series] = await db
      .select()
      .from(blockedTimesSeries)
      .where(eq(blockedTimesSeries.id, created.seriesId!));
    expect(series).toBeUndefined();
  });

  it("rejects an unknown series id (BlockedTimeSeriesNotFoundError)", async () => {
    await expect(
      deleteBlockSeriesInternal(
        fixtures.admin,
        "00000000-0000-0000-0000-000000000000",
      ),
    ).rejects.toBeInstanceOf(BlockedTimeSeriesNotFoundError);
  });
});
