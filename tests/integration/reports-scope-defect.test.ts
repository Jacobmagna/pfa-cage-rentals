// Regression coverage for reports-tabs SPEC §1(b) — the defect Phase B
// deletes.
//
// The bug: `fetchReportData` gated its work-hour query on
//
//     includeProgramHours && (resourceTypes.length === 0 ||
//                             resourceTypes.length === 3)
//
// Work logs are not resource bookings, so narrowing the resource-type
// filter to (say) "Cages" silently dropped EVERY work hour from the
// report — with the "Work hours" checkbox still ticked. Mark hit this
// looking for David Lusk's work sessions and found only cage rentals.
//
// Both halves of that predicate are now gone: the scope checkboxes were
// deleted (the sub-tabs replaced them) and resource types apply to the
// cage side only (SPEC §4). These tests pin the fix at the layer the bug
// actually lived in, so no future refactor can reintroduce the coupling
// without going red.
//
// Hits a real Neon dev branch; see tests/integration/setup.ts.
// truncateMutables() does NOT touch hour_logs or programs, so this file
// creates its own uniquely-named program and cleans up after itself.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { hourLogs, programs, sessionsBilling } from "@/db/schema";
import type { ResourceType } from "@/lib/billing";
import { fetchReportData } from "@/lib/reports/fetch";
import type { NormalizedFilters } from "@/lib/reports/filters";
import { ensureFixtureUsers, getSeededResources } from "./fixtures";

let coachId: string;
let adminId: string;
let programId: string;
let cageResourceId: string;
const createdLogIds: string[] = [];
const createdSessionIds: string[] = [];

// A 1-hour work log at $25/30min → 2 slots × 2500 = $50.00.
const WORK_RATE_PER_30_MIN_CENTS = 2500;
const EXPECTED_WORK_CENTS = 5000;
// A 1-hour cage session at $22/30min → 2 × 2200 = $44.00.
const CAGE_RATE_PER_30_MIN_CENTS = 2200;
const EXPECTED_CAGE_CENTS = 4400;

// A fixed day five days back — far from any month boundary.
const dayStartUtc = (() => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 5);
  d.setUTCHours(17, 0, 0, 0); // ~9-10 AM Pacific
  return d;
})();

function at(hoursOffset: number): Date {
  return new Date(dayStartUtc.getTime() + hoursOffset * 3_600_000);
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const fromDate = new Date(dayStartUtc.getTime() - 24 * 3_600_000);
const toDateExclusive = new Date(dayStartUtc.getTime() + 24 * 3_600_000);

function filters(resourceTypes: ResourceType[] = []): NormalizedFilters {
  return {
    from: ymd(fromDate),
    to: ymd(dayStartUtc),
    fromDate,
    toDateExclusive,
    // Scoped to the one coach this file seeds, so a populated dev branch
    // can't leak other rows into the assertions.
    coachIds: [coachId],
    resourceTypes,
  };
}

beforeAll(async () => {
  const fixtures = await ensureFixtureUsers();
  coachId = fixtures.coach.id;
  adminId = fixtures.admin.id;

  const { cage1 } = await getSeededResources();
  cageResourceId = cage1.id;

  const [program] = await db
    .insert(programs)
    .values({
      name: `Scope Defect Program ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      active: true,
    })
    .returning({ id: programs.id });
  programId = program.id;

  const logRows = await db
    .insert(hourLogs)
    .values({
      coachId,
      programId,
      startAt: at(0),
      endAt: at(1),
      ratePer30MinCents: WORK_RATE_PER_30_MIN_CENTS,
      status: "posted",
      createdBy: adminId,
    })
    .returning({ id: hourLogs.id });
  createdLogIds.push(...logRows.map((r) => r.id));

  // A cage rental for the SAME coach, so the two categories can be
  // asserted independently and a narrowed resource filter has something
  // legitimate to act on.
  const sessionRows = await db
    .insert(sessionsBilling)
    .values({
      coachId,
      resourceId: cageResourceId,
      startAt: at(3),
      endAt: at(4),
      ratePer30MinCents: CAGE_RATE_PER_30_MIN_CENTS,
      createdBy: adminId,
    })
    .returning({ id: sessionsBilling.id });
  createdSessionIds.push(...sessionRows.map((r) => r.id));
});

afterAll(async () => {
  if (createdSessionIds.length > 0) {
    await db
      .delete(sessionsBilling)
      .where(inArray(sessionsBilling.id, createdSessionIds));
  }
  if (createdLogIds.length > 0) {
    await db.delete(hourLogs).where(inArray(hourLogs.id, createdLogIds));
  }
  if (programId) {
    await db.delete(programs).where(eq(programs.id, programId));
  }
});

describe("fetchReportData — work hours survive EVERY resource-type filter", () => {
  // The exact shapes that used to zero the work total. Under the old
  // predicate only `[]` and the full three-element set passed.
  const NARROWING: ResourceType[][] = [
    ["cage"],
    ["bullpen"],
    ["weight_room"],
    ["cage", "bullpen"],
    ["cage", "weight_room"],
    ["bullpen", "weight_room"],
  ];

  // Wrapped in a tuple so each case is ONE argument — `it.each` spreads a
  // bare array, which would label every multi-type case by its first
  // element and make two different cases read identically.
  it.each(NARROWING.map((types) => [types] as const))(
    "resourceTypes=%j still reports the work pay",
    async (resourceTypes) => {
      const report = await fetchReportData(filters([...resourceTypes]));
      expect(report.programGrandTotalCents).toBe(EXPECTED_WORK_CENTS);
    },
  );

  it("an unnarrowed filter reports the work pay", async () => {
    const report = await fetchReportData(filters([]));
    expect(report.programGrandTotalCents).toBe(EXPECTED_WORK_CENTS);
  });

  it("all three types selected reports the work pay", async () => {
    const report = await fetchReportData(
      filters(["cage", "bullpen", "weight_room"]),
    );
    expect(report.programGrandTotalCents).toBe(EXPECTED_WORK_CENTS);
  });

  it("the work total is IDENTICAL narrowed vs unnarrowed", async () => {
    // The property that matters, stated directly: resource types are a
    // cage-side filter and must not move the work number at all.
    const narrowed = await fetchReportData(filters(["cage"]));
    const unnarrowed = await fetchReportData(filters([]));
    expect(narrowed.programGrandTotalCents).toBe(
      unnarrowed.programGrandTotalCents,
    );
    expect(narrowed.summary[0].programHours).toBe(
      unnarrowed.summary[0].programHours,
    );
    expect(narrowed.summary[0].programTotalCents).toBe(
      unnarrowed.summary[0].programTotalCents,
    );
  });

  it("surfaces the work hours on the coach's summary row", async () => {
    const report = await fetchReportData(filters(["cage"]));
    const row = report.summary.find((r) => r.coachId === coachId);
    expect(row).toBeDefined();
    expect(row!.programHours).toBe(1);
    expect(row!.programTotalCents).toBe(EXPECTED_WORK_CENTS);
  });
});

describe("fetchReportData — resource types still filter the CAGE side", () => {
  it("keeps the cage session when cage is selected", async () => {
    const report = await fetchReportData(filters(["cage"]));
    expect(report.grandTotalCents).toBe(EXPECTED_CAGE_CENTS);
    expect(report.detail).toHaveLength(1);
  });

  it("drops the cage session when only bullpen is selected", async () => {
    // Proof the widening did not turn the resource filter into a no-op:
    // the cage side still narrows, it is only the WORK side that is now
    // immune to it.
    const report = await fetchReportData(filters(["bullpen"]));
    expect(report.grandTotalCents).toBe(0);
    expect(report.detail).toHaveLength(0);
    // …while the work pay is untouched by that same filter.
    expect(report.programGrandTotalCents).toBe(EXPECTED_WORK_CENTS);
  });
});

describe("fetchReportData — the two money directions stay separate", () => {
  it("never nets work pay into the cage receivable", async () => {
    const report = await fetchReportData(filters([]));
    const row = report.summary.find((r) => r.coachId === coachId)!;
    // totalCents is the cage receivable ONLY (SPEC §7).
    expect(row.totalCents).toBe(EXPECTED_CAGE_CENTS);
    expect(report.grandTotalCents).toBe(EXPECTED_CAGE_CENTS);
    expect(report.programGrandTotalCents).toBe(EXPECTED_WORK_CENTS);
    expect(report.grandTotalCents).not.toBe(
      EXPECTED_CAGE_CENTS + EXPECTED_WORK_CENTS,
    );
  });
});

describe("fetchReportData — held logs are still excluded", () => {
  it("does not pay a held log", async () => {
    // The scope gate is gone, but the status pin is NOT: held logs are
    // awaiting approval and are not payable. Deleting one predicate must
    // not have loosened the other.
    const [held] = await db
      .insert(hourLogs)
      .values({
        coachId,
        programId,
        startAt: at(6),
        endAt: at(7),
        ratePer30MinCents: WORK_RATE_PER_30_MIN_CENTS,
        status: "held",
        createdBy: adminId,
      })
      .returning({ id: hourLogs.id });
    createdLogIds.push(held.id);

    const report = await fetchReportData(filters([]));
    // Still only the one POSTED log's pay.
    expect(report.programGrandTotalCents).toBe(EXPECTED_WORK_CENTS);
  });
});
