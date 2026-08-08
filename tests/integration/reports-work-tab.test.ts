// Integration coverage for the Reports "Work hours" tab (reports-tabs
// SPEC Phase C), against a real Neon dev branch.
//
// Two things are worth proving here that a unit test cannot:
//
//   1. The Work tab's on-screen total and `fetchReportData`'s aggregate
//      (which feeds the workbook's Summary sheet) AGREE — under every
//      filter, including a program filter, which only one of the two
//      queries used to know about. Two numbers for one figure is the
//      failure SPEC §8 names.
//   2. Rejected logs are excluded from the Work tab but still returned by
//      the shared fetch, i.e. the exclusion happens in OUR shaping and did
//      not quietly change the query the admin Work Log page depends on.
//
// truncateMutables() does NOT touch hour_logs or programs, so this file
// creates its own uniquely-named programs and cleans up after itself.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { hourLogs, programs } from "@/db/schema";
import { fetchReportData } from "@/lib/reports/fetch";
import type { NormalizedFilters } from "@/lib/reports/filters";
import { fetchHourLogRowsWithScheduleNotes } from "@/lib/reports/hour-log-fetch";
import { hourLogFiltersFromReportFilters } from "@/lib/reports/hour-log-filters";
import { buildWorkReport } from "@/lib/reports/work-report";
import { ensureFixtureUsers } from "./fixtures";

let coachA: string;
let coachB: string;
let adminId: string;
let programX: string;
let programY: string;
const createdLogIds: string[] = [];

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

function reportFilters(
  overrides: Partial<NormalizedFilters> = {},
): NormalizedFilters {
  return {
    from: ymd(fromDate),
    to: ymd(dayStartUtc),
    fromDate,
    toDateExclusive,
    coachIds: [coachA, coachB],
    resourceTypes: [],
    ...overrides,
  };
}

// The ACTUAL projection the reports page uses — imported, not copied, so
// a change to it cannot pass these tests while breaking the page.
const toWorkFilters = hourLogFiltersFromReportFilters;

async function workTotalOnScreen(f: NormalizedFilters): Promise<number> {
  const rows = await fetchHourLogRowsWithScheduleNotes(toWorkFilters(f));
  return buildWorkReport(rows).grandTotalCents;
}

beforeAll(async () => {
  const fixtures = await ensureFixtureUsers();
  coachA = fixtures.coach.id;
  coachB = fixtures.flaggedCoach.id;
  adminId = fixtures.admin.id;

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const inserted = await db
    .insert(programs)
    .values([
      { name: `Work Tab Program X ${stamp}`, active: true },
      { name: `Work Tab Program Y ${stamp}`, active: true },
    ])
    .returning({ id: programs.id });
  programX = inserted[0].id;
  programY = inserted[1].id;

  const rows = await db
    .insert(hourLogs)
    .values([
      // Coach A, program X: 1h hourly @ $30/hr → $30.00
      {
        coachId: coachA,
        programId: programX,
        startAt: at(0),
        endAt: at(1),
        ratePer30MinCents: 1500,
        status: "posted",
        createdBy: adminId,
      },
      // Coach A, program Y: 2h flat per-session $100 → $100.00
      {
        coachId: coachA,
        programId: programY,
        startAt: at(2),
        endAt: at(4),
        ratePer30MinCents: 1500,
        perSessionRateCents: 10000,
        status: "posted",
        createdBy: adminId,
      },
      // Coach B, program X: 1.5h @ $44/hr → $66.00
      {
        coachId: coachB,
        programId: programX,
        startAt: at(5),
        endAt: at(6.5),
        ratePer30MinCents: 2200,
        status: "posted",
        createdBy: adminId,
      },
      // Coach B, program X: REJECTED — must never reach a total.
      {
        coachId: coachB,
        programId: programX,
        startAt: at(8),
        endAt: at(9),
        ratePer30MinCents: 999900,
        status: "rejected",
        reviewedAt: new Date(),
        reviewedBy: adminId,
        createdBy: adminId,
      },
      // Coach B, program X: HELD — excluded upstream by the fetch.
      {
        coachId: coachB,
        programId: programX,
        startAt: at(10),
        endAt: at(11),
        ratePer30MinCents: 888800,
        status: "held",
        createdBy: adminId,
      },
    ])
    .returning({ id: hourLogs.id });
  createdLogIds.push(...rows.map((r) => r.id));
});

afterAll(async () => {
  if (createdLogIds.length > 0) {
    await db.delete(hourLogs).where(inArray(hourLogs.id, createdLogIds));
  }
  if (programX) await db.delete(programs).where(eq(programs.id, programX));
  if (programY) await db.delete(programs).where(eq(programs.id, programY));
});

const TOTAL_ALL = 3000 + 10000 + 6600; // $196.00
const TOTAL_PROGRAM_X = 3000 + 6600; // $96.00
const TOTAL_COACH_A = 3000 + 10000; // $130.00

describe("Work tab — totals", () => {
  it("sums posted work across both coaches and both programs", async () => {
    expect(await workTotalOnScreen(reportFilters())).toBe(TOTAL_ALL);
  });

  it("respects the program filter", async () => {
    expect(
      await workTotalOnScreen(reportFilters({ programId: programX })),
    ).toBe(TOTAL_PROGRAM_X);
  });

  it("respects the coach filter", async () => {
    expect(await workTotalOnScreen(reportFilters({ coachIds: [coachA] }))).toBe(
      TOTAL_COACH_A,
    );
  });

  it("pays a per-session log its FLAT fee, not its hourly rate", async () => {
    // 2h at $30/hr would be $60; the flat stamp says $100.
    const rows = await fetchHourLogRowsWithScheduleNotes(
      toWorkFilters(reportFilters({ programId: programY })),
    );
    const { detail } = buildWorkReport(rows);
    expect(detail).toHaveLength(1);
    expect(detail[0].payCents).toBe(10000);
    expect(detail[0].hours).toBe(2);
  });
});

describe("Work tab — the on-screen total AGREES with the aggregate", () => {
  // fetchReportData's hour-log roll-up feeds the workbook's Summary sheet.
  // If it and the Work tab ever disagree, one screen quotes a number the
  // download contradicts.
  it("agrees with no filters", async () => {
    const f = reportFilters();
    const report = await fetchReportData(f);
    expect(report.programGrandTotalCents).toBe(await workTotalOnScreen(f));
  });

  it("agrees under a PROGRAM filter", async () => {
    // The one that used to be impossible: fetchReportData had no program
    // predicate at all, so a program-narrowed screen and the workbook
    // would have quoted different work totals.
    const f = reportFilters({ programId: programX });
    const report = await fetchReportData(f);
    expect(report.programGrandTotalCents).toBe(TOTAL_PROGRAM_X);
    expect(report.programGrandTotalCents).toBe(await workTotalOnScreen(f));
  });

  it("agrees under a COACH filter", async () => {
    const f = reportFilters({ coachIds: [coachA] });
    const report = await fetchReportData(f);
    expect(report.programGrandTotalCents).toBe(await workTotalOnScreen(f));
  });

  it("agrees under a narrowed RESOURCE-TYPE filter", async () => {
    // Resource types must move neither number (SPEC §4).
    const f = reportFilters({ resourceTypes: ["cage"] });
    const report = await fetchReportData(f);
    expect(report.programGrandTotalCents).toBe(TOTAL_ALL);
    expect(report.programGrandTotalCents).toBe(await workTotalOnScreen(f));
  });
});

describe("Work tab — rejected and held logs", () => {
  it("the shared fetch still RETURNS rejected rows", async () => {
    // Proof the exclusion lives in our shaping, not in a changed query —
    // the admin Work Log page depends on getting these back to badge them.
    const rows = await fetchHourLogRowsWithScheduleNotes(
      toWorkFilters(reportFilters()),
    );
    expect(rows.some((r) => r.status === "rejected")).toBe(true);
  });

  it("but the Work tab excludes them from detail and totals", async () => {
    const rows = await fetchHourLogRowsWithScheduleNotes(
      toWorkFilters(reportFilters()),
    );
    const { detail, grandTotalCents } = buildWorkReport(rows);
    expect(detail.every((d) => d.payCents < 999900)).toBe(true);
    expect(grandTotalCents).toBe(TOTAL_ALL);
  });

  it("held logs never reach the tab at all", async () => {
    const rows = await fetchHourLogRowsWithScheduleNotes(
      toWorkFilters(reportFilters()),
    );
    expect(rows.some((r) => r.status === "held")).toBe(false);
  });
});

describe("Work tab — detail reconciles with summary against real rows", () => {
  it("summary equals the detail it was built from", async () => {
    const rows = await fetchHourLogRowsWithScheduleNotes(
      toWorkFilters(reportFilters()),
    );
    const { detail, summary, grandTotalCents } = buildWorkReport(rows);
    expect(summary.reduce((n, s) => n + s.payCents, 0)).toBe(grandTotalCents);
    expect(summary.reduce((n, s) => n + s.entries, 0)).toBe(detail.length);
    for (const s of summary) {
      const mine = detail.filter((d) => d.coachId === s.coachId);
      expect(s.payCents).toBe(mine.reduce((n, d) => n + d.payCents, 0));
    }
  });

  it("carries the rate snapshots needed to display a rate", async () => {
    // This fetch had NO money columns before Phase C.
    const rows = await fetchHourLogRowsWithScheduleNotes(
      toWorkFilters(reportFilters({ programId: programX })),
    );
    const { detail } = buildWorkReport(rows);
    expect(detail.length).toBeGreaterThan(0);
    expect(
      detail.every(
        (d) => d.ratePer30MinCents !== null || d.perSessionRateCents !== null,
      ),
    ).toBe(true);
  });
});
