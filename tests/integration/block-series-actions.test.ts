// Integration tests for src/lib/server/block-series-actions.ts (BLOCK-RECUR +
// MULTI-CAGE). Hits the real Neon dev branch. Same direct-internal pattern as
// the other suites — call the *Internal exports with the fixture admin actor.
//
// truncateMutables() TRUNCATEs blocked_times + sessions_billing + audit_log,
// so each test starts with a clean resource. blocked_times_series is NOT
// truncated, so we delete created series in afterEach (cascade clears any
// remaining occurrence blocks). Requires migrations 0040 + 0041 on the dev
// branch (0041 adds blocked_times_series.resource_ids).

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
  createBlocksBatchInternal,
  createBlockSeriesInternal,
  deleteBlockSeriesInternal,
  editBlockSeriesInternal,
} from "@/lib/server/block-series-actions";
import { generateOccurrences } from "@/lib/schedule-recurrence";
import { formatPfaDate } from "@/lib/timezone";
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
let cage2Id: string;
const createdSeriesIds: string[] = [];

beforeAll(async () => {
  fixtures = await ensureFixtureUsers();
  const { cage1, cage2 } = await getSeededResources();
  cageId = cage1.id;
  cage2Id = cage2.id;
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

// Insert a rental on a resource covering a given UTC instant window.
async function insertRental(
  startAt: Date,
  endAt: Date,
  resourceId: string = cageId,
): Promise<void> {
  await db.insert(sessionsBilling).values({
    coachId: fixtures.coach.id,
    resourceId,
    startAt,
    endAt,
    ratePer30MinCents: 2200,
    createdBy: fixtures.admin.id,
  });
}

async function insertOneOffBlock(
  startAt: Date,
  endAt: Date,
  resourceId: string = cageId,
): Promise<void> {
  await db.insert(blockedTimes).values({
    resourceId,
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
      resourceIds: [cageId],
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
    // MULTI-CAGE: single-cage series records its one cage in both columns.
    expect(series.resourceId).toBe(cageId);
    expect(series.resourceIds).toEqual([cageId]);

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

  it("MULTI-CAGE: materializes one row per (cage, date) across all cages", async () => {
    const startsOn = isoDaysFromToday(1);
    const endsOn = isoDaysFromToday(15);
    const occ = generateOccurrences({
      daysOfWeek: [1, 3],
      startTime: "15:00",
      endTime: "17:00",
      startsOn,
      endsOn,
    });

    const res = await createBlockSeriesInternal(fixtures.admin, {
      resourceIds: [cageId, cage2Id],
      reason: "Two-cage camp",
      daysOfWeek: [1, 3],
      startTime: "15:00",
      endTime: "17:00",
      startsOn,
      endsOn,
    });
    if (res.seriesId) createdSeriesIds.push(res.seriesId);

    // created counts rows across BOTH cages.
    expect(res.created).toBe(occ.length * 2);
    const blocks = await seriesBlocks(res.seriesId!);
    expect(blocks).toHaveLength(occ.length * 2);
    expect(blocks.filter((b) => b.resourceId === cageId)).toHaveLength(
      occ.length,
    );
    expect(blocks.filter((b) => b.resourceId === cage2Id)).toHaveLength(
      occ.length,
    );

    const [series] = await db
      .select()
      .from(blockedTimesSeries)
      .where(eq(blockedTimesSeries.id, res.seriesId!));
    expect(series.resourceId).toBe(cageId); // denormalized primary = first
    expect(series.resourceIds.sort()).toEqual([cageId, cage2Id].sort());
  });

  it("MULTI-CAGE: skip-and-continue is PER CAGE (one cage's rental doesn't block the other)", async () => {
    const startsOn = isoDaysFromToday(1);
    const endsOn = isoDaysFromToday(15);
    const occ = generateOccurrences({
      daysOfWeek: [1, 3],
      startTime: "15:00",
      endTime: "17:00",
      startsOn,
      endsOn,
    });
    // Rent CAGE 1 over its first occurrence only. Cage 2 stays free.
    await insertRental(occ[0].startAt, occ[0].endAt, cageId);

    const res = await createBlockSeriesInternal(fixtures.admin, {
      resourceIds: [cageId, cage2Id],
      reason: "Two-cage camp",
      daysOfWeek: [1, 3],
      startTime: "15:00",
      endTime: "17:00",
      startsOn,
      endsOn,
    });
    if (res.seriesId) createdSeriesIds.push(res.seriesId);

    // Cage 1 skips 1; Cage 2 blocks all. created = (occ-1) + occ.
    expect(res.created).toBe(occ.length * 2 - 1);
    expect(res.skippedRentals).toHaveLength(1);
    expect(res.skippedRentals[0].resourceName).toBeTruthy();
    expect(res.skippedRentals[0].label).toContain(
      res.skippedRentals[0].resourceName,
    );
    const blocks = await seriesBlocks(res.seriesId!);
    expect(blocks.filter((b) => b.resourceId === cage2Id)).toHaveLength(
      occ.length,
    );
    expect(blocks.filter((b) => b.resourceId === cageId)).toHaveLength(
      occ.length - 1,
    );
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
    await insertRental(occ[0].startAt, occ[0].endAt);

    const res = await createBlockSeriesInternal(fixtures.admin, {
      resourceIds: [cageId],
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
      resourceIds: [cageId],
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
    for (const o of occ) await insertRental(o.startAt, o.endAt);

    const res = await createBlockSeriesInternal(fixtures.admin, {
      resourceIds: [cageId],
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
  });

  it("rejects an unknown resource (ResourceNotFoundError)", async () => {
    await expect(
      createBlockSeriesInternal(fixtures.admin, {
        resourceIds: ["00000000-0000-0000-0000-000000000000"],
        reason: "x",
        daysOfWeek: [1],
        startTime: "15:00",
        endTime: "17:00",
        startsOn: isoDaysFromToday(1),
        endsOn: isoDaysFromToday(8),
      }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("rejects when ANY of several resources is unknown", async () => {
    await expect(
      createBlockSeriesInternal(fixtures.admin, {
        resourceIds: [cageId, "00000000-0000-0000-0000-000000000000"],
        reason: "x",
        daysOfWeek: [1],
        startTime: "15:00",
        endTime: "17:00",
        startsOn: isoDaysFromToday(1),
        endsOn: isoDaysFromToday(8),
      }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("rejects an empty resourceIds set (zod)", async () => {
    await expect(
      createBlockSeriesInternal(fixtures.admin, {
        resourceIds: [],
        reason: "x",
        daysOfWeek: [1],
        startTime: "15:00",
        endTime: "17:00",
        startsOn: isoDaysFromToday(1),
        endsOn: isoDaysFromToday(8),
      }),
    ).rejects.toBeTruthy();
  });

  it("hard-rejects an over-cap date range (>366 occurrences)", async () => {
    await expect(
      createBlockSeriesInternal(fixtures.admin, {
        resourceIds: [cageId],
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

describe("createBlocksBatchInternal (one-off, multi-cage)", () => {
  it("blocks a single resource (created:1)", async () => {
    const startAt = new Date();
    startAt.setUTCHours(startAt.getUTCHours() + 24, 0, 0, 0);
    const endAt = new Date(startAt.getTime() + 60 * 60 * 1000);

    const res = await createBlocksBatchInternal(fixtures.admin, {
      resourceIds: [cageId],
      startAt,
      endAt,
      reason: "HVAC repair",
    });
    expect(res.created).toBe(1);
    expect(res.skippedRentals).toHaveLength(0);

    const rows = await db
      .select()
      .from(blockedTimes)
      .where(eq(blockedTimes.resourceId, cageId));
    expect(rows).toHaveLength(1);
    expect(rows[0].seriesId).toBeNull(); // one-off, not a series
    expect(rows[0].reason).toBe("HVAC repair");
  });

  it("blocks MANY resources in one call (one row each)", async () => {
    const startAt = new Date();
    startAt.setUTCHours(startAt.getUTCHours() + 24, 0, 0, 0);
    const endAt = new Date(startAt.getTime() + 60 * 60 * 1000);

    const res = await createBlocksBatchInternal(fixtures.admin, {
      resourceIds: [cageId, cage2Id],
      startAt,
      endAt,
      reason: "Team event",
    });
    expect(res.created).toBe(2);
    const rows = await db
      .select()
      .from(blockedTimes)
      .where(inArray(blockedTimes.resourceId, [cageId, cage2Id]));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.seriesId === null)).toBe(true);
  });

  it("skip-and-continue: skips a rented cage, blocks the free one", async () => {
    const startAt = new Date();
    startAt.setUTCHours(startAt.getUTCHours() + 24, 0, 0, 0);
    const endAt = new Date(startAt.getTime() + 60 * 60 * 1000);
    await insertRental(startAt, endAt, cageId); // Cage 1 busy

    const res = await createBlocksBatchInternal(fixtures.admin, {
      resourceIds: [cageId, cage2Id],
      startAt,
      endAt,
      reason: "Team event",
    });
    expect(res.created).toBe(1); // only Cage 2
    expect(res.skippedRentals).toHaveLength(1);
    const rows = await db
      .select()
      .from(blockedTimes)
      .where(inArray(blockedTimes.resourceId, [cageId, cage2Id]));
    expect(rows).toHaveLength(1);
    expect(rows[0].resourceId).toBe(cage2Id);
  });

  it("rejects an unknown resource", async () => {
    const startAt = new Date();
    startAt.setUTCHours(startAt.getUTCHours() + 24, 0, 0, 0);
    const endAt = new Date(startAt.getTime() + 60 * 60 * 1000);
    await expect(
      createBlocksBatchInternal(fixtures.admin, {
        resourceIds: ["00000000-0000-0000-0000-000000000000"],
        startAt,
        endAt,
        reason: "x",
      }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});

describe("editBlockSeriesInternal", () => {
  it("regenerates FUTURE occurrences and leaves PAST ones untouched", async () => {
    const base = {
      resourceIds: [cageId],
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

    const res = await editBlockSeriesInternal(fixtures.admin, created.seriesId!, {
      ...base,
      startTime: "14:00",
      endTime: "15:00",
    });

    const after = await seriesBlocks(created.seriesId!);
    const pastIdsAfter = after.filter((b) => b.startAt < now).map((b) => b.id).sort();
    const futureIdsAfter = after.filter((b) => b.startAt >= now).map((b) => b.id);

    // res.created == the regenerated FUTURE rows. Compared to the post-edit
    // future set (not futureIdsBefore) so it's robust to running between the
    // old (10:00) and new (14:00) start times — otherwise today's occurrence
    // straddles `now` differently before vs after and the count is off by one.
    expect(res.created).toBe(futureIdsAfter.length);
    expect(pastIdsAfter).toEqual(pastIds);
    for (const oldId of futureIdsBefore) {
      expect(futureIdsAfter).not.toContain(oldId);
    }
    const [series] = await db
      .select()
      .from(blockedTimesSeries)
      .where(eq(blockedTimesSeries.id, created.seriesId!));
    expect(series.startTime).toBe("14:00");
  });

  it("MULTI-CAGE: adding a cage on edit regenerates future rows for BOTH cages", async () => {
    const base = {
      resourceIds: [cageId],
      reason: "Maintenance",
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      startTime: "10:00",
      endTime: "11:00",
      startsOn: isoDaysFromToday(-2),
      endsOn: isoDaysFromToday(10),
    };
    const created = await createBlockSeriesInternal(fixtures.admin, base);
    createdSeriesIds.push(created.seriesId!);

    const now = new Date();
    // Add cage 2 to the series.
    await editBlockSeriesInternal(fixtures.admin, created.seriesId!, {
      ...base,
      resourceIds: [cageId, cage2Id],
    });

    const after = await seriesBlocks(created.seriesId!);
    const future = after.filter((b) => b.startAt >= now);
    // Every future date now has a row on BOTH cages.
    expect(future.filter((b) => b.resourceId === cageId).length).toBeGreaterThan(0);
    expect(future.filter((b) => b.resourceId === cage2Id).length).toBeGreaterThan(0);
    expect(future.filter((b) => b.resourceId === cageId).length).toBe(
      future.filter((b) => b.resourceId === cage2Id).length,
    );

    const [series] = await db
      .select()
      .from(blockedTimesSeries)
      .where(eq(blockedTimesSeries.id, created.seriesId!));
    expect(series.resourceIds.sort()).toEqual([cageId, cage2Id].sort());
  });

  it("skip-and-continue on edit: a future occurrence colliding with a rental is skipped + reported", async () => {
    const base = {
      resourceIds: [cageId],
      reason: "Maintenance",
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      startTime: "10:00",
      endTime: "11:00",
      startsOn: isoDaysFromToday(-2),
      endsOn: isoDaysFromToday(10),
    };
    const created = await createBlockSeriesInternal(fixtures.admin, base);
    createdSeriesIds.push(created.seriesId!);

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

  it("CAGE-SCOPED cancel + regenerate: cancelling one cage's date does NOT drop it on the other cage", async () => {
    // Multi-cage weekly series over BOTH cages, spanning several weeks so a
    // future date materializes on both.
    const base = {
      resourceIds: [cageId, cage2Id],
      reason: "Two-cage camp",
      daysOfWeek: [1, 3],
      startTime: "10:00",
      endTime: "11:00",
      startsOn: isoDaysFromToday(1),
      endsOn: isoDaysFromToday(29),
    };
    const created = await createBlockSeriesInternal(fixtures.admin, base);
    createdSeriesIds.push(created.seriesId!);

    // Pick a future date D that materialized on BOTH cages.
    const blocks = await seriesBlocks(created.seriesId!);
    const cage1Dates = new Set(
      blocks.filter((b) => b.resourceId === cageId).map((b) => formatPfaDate(b.startAt)),
    );
    const cage2Block = blocks.find(
      (b) => b.resourceId === cage2Id && cage1Dates.has(formatPfaDate(b.startAt)),
    );
    expect(cage2Block).toBeDefined();
    const D = formatPfaDate(cage2Block!.startAt);

    // Cancel ONLY cage 2's occurrence on D.
    await cancelBlockSeriesOccurrenceInternal(fixtures.admin, cage2Block!.id);

    // skipDates records a COMPOSITE key (cage-scoped), not a bare date.
    const [series] = await db
      .select()
      .from(blockedTimesSeries)
      .where(eq(blockedTimesSeries.id, created.seriesId!));
    expect(series.skipDates).toContain(`${cage2Id}|${D}`);
    expect(series.skipDates).not.toContain(D);

    // Edit the series with the SAME pattern (only reason changes) → regenerate.
    await editBlockSeriesInternal(fixtures.admin, created.seriesId!, {
      ...base,
      reason: "Two-cage camp (edited)",
    });

    // AFTER regenerate: cage 1 STILL has a block on D; cage 2 does NOT.
    const after = await seriesBlocks(created.seriesId!);
    const cage1OnD = after.filter(
      (b) => b.resourceId === cageId && formatPfaDate(b.startAt) === D,
    );
    const cage2OnD = after.filter(
      (b) => b.resourceId === cage2Id && formatPfaDate(b.startAt) === D,
    );
    expect(cage1OnD).toHaveLength(1);
    expect(cage2OnD).toHaveLength(0);
  });

  it("LEGACY bare-date skip is GLOBAL: skips the date on ALL cages (back-compat)", async () => {
    const base = {
      resourceIds: [cageId, cage2Id],
      reason: "Two-cage camp",
      daysOfWeek: [1, 3],
      startTime: "10:00",
      endTime: "11:00",
      startsOn: isoDaysFromToday(1),
      endsOn: isoDaysFromToday(29),
    };
    const created = await createBlockSeriesInternal(fixtures.admin, base);
    createdSeriesIds.push(created.seriesId!);

    // Pick a future date D present on both cages.
    const blocks = await seriesBlocks(created.seriesId!);
    const D = formatPfaDate(blocks[0].startAt);

    // Manually set a LEGACY bare-date skip (pre-multi-cage shape).
    await db
      .update(blockedTimesSeries)
      .set({ skipDates: [D] })
      .where(eq(blockedTimesSeries.id, created.seriesId!));

    // Regenerate with the same pattern.
    await editBlockSeriesInternal(fixtures.admin, created.seriesId!, { ...base });

    // Bare date is a global skip → NO cage has a block on D.
    const after = await seriesBlocks(created.seriesId!);
    const onD = after.filter((b) => formatPfaDate(b.startAt) === D);
    expect(onD).toHaveLength(0);
  });

  it("rejects an unknown series id (BlockedTimeSeriesNotFoundError)", async () => {
    await expect(
      editBlockSeriesInternal(fixtures.admin, "00000000-0000-0000-0000-000000000000", {
        resourceIds: [cageId],
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
      resourceIds: [cageId],
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
    // cancelledDate stays the plain date for the caller/UI, but skipDates stores
    // the CAGE-SCOPED composite key "<resourceId>|<date>".
    expect(res.cancelledDate).toBe(formatPfaDate(target.startAt));
    expect(series.skipDates).toContain(`${target.resourceId}|${res.cancelledDate}`);
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
  it("deletes the series and cascades ALL its occurrences (across cages)", async () => {
    const created = await createBlockSeriesInternal(fixtures.admin, {
      resourceIds: [cageId, cage2Id],
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
