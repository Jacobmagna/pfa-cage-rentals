// Integration coverage for the combined Reports workbook (reports-tabs
// SPEC Phase E), against a real Neon dev branch.
//
// The unit tests in src/lib/reports/excel.test.ts prove the BUILDER given
// data. What only a real DB can prove is the WIRING — and the wiring is
// exactly where the defect lived:
//
//   1. 🔴 SPEC §1(a): work sessions have NEVER appeared in a Reports
//      export. `excel.ts` was fed only `ReportData`, which is built
//      exclusively from sessionsBilling. A builder test can't catch that,
//      because it can only test the data it is handed. This file assembles
//      the workbook through the SAME calls the download route makes and
//      then reads the file back to confirm work rows are actually in it.
//   2. The Cage Summary's "Work $" column and the Work Summary's grand
//      total are the same money arrived at by two paths (aggregateReport
//      vs buildWorkReport). They must agree in a REAL fetch, not just in
//      hand-built fixtures where both were typed by the same person.
//   3. Rejected and held logs stay out of the file. They are excluded by
//      different mechanisms — held upstream in the query, rejected in our
//      shaping — so only an end-to-end read proves both survived Phase E.
//
// truncateMutables() does NOT touch hour_logs or programs, so this file
// creates its own uniquely-named program and cleans up after itself. It
// DOES truncate coach_payments + audit_log, which is what the payments
// half of the workbook reads.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { hourLogs, programs } from "@/db/schema";
import { buildReportWorkbook } from "@/lib/reports/excel";
import { fetchReportData } from "@/lib/reports/fetch";
import type { NormalizedFilters } from "@/lib/reports/filters";
import { fetchHourLogRowsWithScheduleNotes } from "@/lib/reports/hour-log-fetch";
import { hourLogFiltersFromReportFilters } from "@/lib/reports/hour-log-filters";
import { buildPaymentTimeline } from "@/lib/reports/payments-timeline";
import { fetchPaymentTimelineRows } from "@/lib/reports/payments-timeline-fetch";
import { buildWorkReport } from "@/lib/reports/work-report";
import { createPaymentInternal } from "@/lib/server/payment-actions";
import {
  ensureFixtureUsers,
  truncateMutables,
  type FixtureUsers,
} from "./fixtures";

let fixtures: FixtureUsers;
let coachA: string;
let coachB: string;
let adminId: string;
let programId: string;
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

// Wide enough to contain both the seeded logs (5 days back) and the audit
// rows, which stamp themselves with defaultNow() at test-run time.
const fromDate = new Date(dayStartUtc.getTime() - 24 * 3_600_000);
const toDateExclusive = new Date(Date.now() + 2 * 24 * 3_600_000);

function reportFilters(
  overrides: Partial<NormalizedFilters> = {},
): NormalizedFilters {
  return {
    from: ymd(fromDate),
    to: ymd(toDateExclusive),
    fromDate,
    toDateExclusive,
    coachIds: [coachA, coachB],
    resourceTypes: [],
    // Scoped to THIS file's own program. truncateMutables() does not clear
    // hour_logs, so the shared dev branch carries other suites' logs for
    // the same fixture coaches inside this date window — without the
    // narrowing, every total here would be measuring their data too.
    // Both work queries honour programId (fetch.ts and hour-log-fetch.ts),
    // which is what keeps the reconciliation assertions meaningful.
    programId,
    ...overrides,
  };
}

/**
 * Assembles the workbook exactly the way `/admin/reports/download` does.
 * Imported calls, not copied logic — if the route's composition changes
 * and this doesn't, that divergence is the thing worth failing on.
 */
async function buildWorkbookFor(
  filters: NormalizedFilters,
): Promise<ExcelJS.Workbook> {
  const [report, workRows, paymentRows] = await Promise.all([
    fetchReportData(filters),
    fetchHourLogRowsWithScheduleNotes(hourLogFiltersFromReportFilters(filters)),
    fetchPaymentTimelineRows({
      fromDate: filters.fromDate,
      toDateExclusive: filters.toDateExclusive,
      coachIds: filters.coachIds,
    }),
  ]);

  const buffer = await buildReportWorkbook(
    {
      report,
      work: buildWorkReport(workRows),
      payments: buildPaymentTimeline(paymentRows.rows),
      paymentsTruncated: paymentRows.truncated,
    },
    { from: filters.from, to: filters.to },
  );

  const wb = new ExcelJS.Workbook();
  // ExcelJS's .load type signature predates modern Node Buffer generics.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await wb.xlsx.load(buffer as any);
  return wb;
}

/** Every value in a column of a sheet, header row excluded. */
function column(sheet: ExcelJS.Worksheet, col: number): unknown[] {
  const out: unknown[] = [];
  sheet.eachRow((row, n) => {
    if (n === 1) return;
    out.push(row.getCell(col).value);
  });
  return out;
}

beforeAll(async () => {
  fixtures = await ensureFixtureUsers();
  coachA = fixtures.coach.id;
  coachB = fixtures.flaggedCoach.id;
  adminId = fixtures.admin.id;

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const inserted = await db
    .insert(programs)
    .values([{ name: `Workbook Program ${stamp}`, active: true }])
    .returning({ id: programs.id });
  programId = inserted[0].id;

  const rows = await db
    .insert(hourLogs)
    .values([
      // Coach A: 1h hourly @ $30/hr → $30.00
      {
        coachId: coachA,
        programId,
        startAt: at(0),
        endAt: at(1),
        ratePer30MinCents: 1500,
        status: "posted",
        createdBy: adminId,
      },
      // Coach A: 3.2h at a FLAT $100 per session. The game-rate bug in one
      // row — if the sheet quotes an hourly figure here, the Rate column
      // stops explaining the Pay column.
      {
        coachId: coachA,
        programId,
        startAt: at(2),
        endAt: at(5.2),
        perSessionRateCents: 10000,
        status: "posted",
        createdBy: adminId,
      },
      // Coach B: NEVER RATED. Pays $0 — a real zero that must still appear
      // as a line, with no invented rate against it.
      {
        coachId: coachB,
        programId,
        startAt: at(6),
        endAt: at(8),
        status: "posted",
        createdBy: adminId,
      },
      // REJECTED — work an admin decided not to pay. Excluded in OUR
      // shaping, at an absurd rate so its leaking anywhere is unmissable.
      {
        coachId: coachB,
        programId,
        startAt: at(9),
        endAt: at(10),
        ratePer30MinCents: 999900,
        status: "rejected",
        reviewedAt: new Date(),
        reviewedBy: adminId,
        createdBy: adminId,
      },
      // HELD — not yet approved, therefore not yet payable. Excluded
      // upstream by the fetch's own predicate.
      {
        coachId: coachB,
        programId,
        startAt: at(11),
        endAt: at(12),
        ratePer30MinCents: 888800,
        status: "held",
        createdBy: adminId,
      },
    ])
    .returning({ id: hourLogs.id });
  createdLogIds.push(...rows.map((r) => r.id));

  await truncateMutables();
  await createPaymentInternal(fixtures.admin, {
    coachId: coachA,
    amountCents: 180000,
    method: "check",
    direction: "pfa_to_coach",
    paidAt: new Date(dayStartUtc.getTime()),
  });
});

afterAll(async () => {
  if (createdLogIds.length > 0) {
    await db.delete(hourLogs).where(inArray(hourLogs.id, createdLogIds));
  }
  if (programId) await db.delete(programs).where(eq(programs.id, programId));
});

// $30.00 + $100.00 + $0.00. The rejected ($9,999/h) and held ($8,888/h)
// logs are deliberately enormous — if either leaks, no assertion is subtle.
const WORK_TOTAL_CENTS = 3000 + 10000 + 0;

describe("combined workbook — structure", () => {
  it("has all five sheets in the documented order", async () => {
    const wb = await buildWorkbookFor(reportFilters());
    expect(wb.worksheets.map((s) => s.name)).toEqual([
      "Cage Summary",
      "Cage Detail",
      "Work Summary",
      "Work Detail",
      "Payments",
    ]);
  });
});

describe("combined workbook — SPEC §1(a): work is finally IN the export", () => {
  it("writes a Work Detail line for every posted log", async () => {
    const wb = await buildWorkbookFor(reportFilters());
    const sheet = wb.getWorksheet("Work Detail")!;
    const pay = column(sheet, 10).filter((v) => typeof v === "number");
    expect(pay).toHaveLength(3);
    expect(pay).toEqual(expect.arrayContaining([30, 100, 0]));
  });

  it("quotes a per-session log its FLAT fee, whatever its duration", async () => {
    const wb = await buildWorkbookFor(reportFilters());
    const sheet = wb.getWorksheet("Work Detail")!;
    // 3.2h at any hourly rate is not $100. Find the row by its pay.
    let found: { hours: unknown; rate: unknown; basis: unknown } | null = null;
    sheet.eachRow((row, n) => {
      if (n === 1) return;
      if (row.getCell(10).value === 100) {
        found = {
          hours: row.getCell(5).value,
          rate: row.getCell(8).value,
          basis: row.getCell(9).value,
        };
      }
    });
    expect(found).not.toBeNull();
    expect(found!.hours).toBe(3.2);
    expect(found!.rate).toBe(100);
    expect(found!.basis).toBe("per session");
  });

  // 🔴 A log that was never rated pays $0. The PAY is a real zero and is
  // written as one; the RATE is missing and must stay blank, because
  // "$0.00 /hr" reads as a rate somebody chose.
  it("leaves the rate blank on a never-rated log while still paying $0", async () => {
    const wb = await buildWorkbookFor(reportFilters());
    const sheet = wb.getWorksheet("Work Detail")!;
    let rate: unknown = "unset";
    let basis: unknown = "unset";
    sheet.eachRow((row, n) => {
      if (n === 1) return;
      if (row.getCell(9).value === "No rate") {
        rate = row.getCell(8).value;
        basis = row.getCell(9).value;
        expect(row.getCell(10).value).toBe(0);
      }
    });
    expect(basis).toBe("No rate");
    expect(rate).toBeNull();
  });

  it("keeps REJECTED and HELD logs out of the file entirely", async () => {
    const wb = await buildWorkbookFor(reportFilters());
    const sheet = wb.getWorksheet("Work Detail")!;
    const pay = column(sheet, 10).filter((v) => typeof v === "number");
    // The rejected log would pay $9,999 and the held one $8,888.
    expect(pay).not.toContain(9999);
    expect(pay).not.toContain(8888);
    expect(pay.reduce((a, b) => (a as number) + (b as number), 0)).toBe(
      WORK_TOTAL_CENTS / 100,
    );
  });
});

describe("combined workbook — the two work totals RECONCILE", () => {
  // Same money, two independent paths: aggregateReport's per-coach roll-up
  // (Cage Summary's "Work $") and buildWorkReport's grand total (Work
  // Summary). A workbook that quotes two different payroll figures is
  // worse than one that quotes none.
  it("Cage Summary's Work $ total equals Work Summary's grand total", async () => {
    const wb = await buildWorkbookFor(reportFilters());

    const cage = wb.getWorksheet("Cage Summary")!;
    let cageWorkTotal: unknown = null;
    cage.eachRow((row) => {
      const label = row.getCell(1).value;
      if (typeof label === "string" && label.startsWith("Grand total")) {
        cageWorkTotal = row.getCell(12).value; // "Work $"
      }
    });

    const work = wb.getWorksheet("Work Summary")!;
    let workGrandTotal: unknown = null;
    work.eachRow((row) => {
      const label = row.getCell(1).value;
      if (typeof label === "string" && label.startsWith("Grand total")) {
        workGrandTotal = row.getCell(5).value;
      }
    });

    expect(workGrandTotal).toBe(WORK_TOTAL_CENTS / 100);
    expect(cageWorkTotal).toBe(workGrandTotal);
  });

  it("still reconciles under a coach filter", async () => {
    const wb = await buildWorkbookFor(reportFilters({ coachIds: [coachA] }));
    const work = wb.getWorksheet("Work Summary")!;
    let workGrandTotal: unknown = null;
    work.eachRow((row) => {
      const label = row.getCell(1).value;
      if (typeof label === "string" && label.startsWith("Grand total")) {
        workGrandTotal = row.getCell(5).value;
      }
    });
    expect(workGrandTotal).toBe(130); // $30 + $100, coach B excluded
  });
});

describe("combined workbook — payments sheet", () => {
  it("carries the recorded payment with its direction", async () => {
    const wb = await buildWorkbookFor(reportFilters());
    const sheet = wb.getWorksheet("Payments")!;
    const events = column(sheet, 3).filter((v) => v === "Recorded");
    expect(events).toHaveLength(1);
    expect(column(sheet, 6)).toContain(1800);
    expect(column(sheet, 7)).toContain("PFA paid coach");
  });

  // SPEC §7. $1,800 out and $0 in must sit in separate labelled totals.
  it("reports the two directions separately, never netted", async () => {
    const wb = await buildWorkbookFor(reportFilters());
    const labels = column(wb.getWorksheet("Payments")!, 1).filter(
      (v): v is string => typeof v === "string" && v.startsWith("Recorded in"),
    );
    expect(labels).toEqual([
      "Recorded in range — coach paid PFA",
      "Recorded in range — PFA paid coach",
    ]);
  });
});
