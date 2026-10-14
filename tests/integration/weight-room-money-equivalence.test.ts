// MONEY EQUIVALENCE for the weight room one-hour minimum, against the real dev
// database (weight room build plan, section 6, "Money equivalence").
//
// The claim: for the same coach and the same stored rate, ONE 60-minute weight
// room row bills exactly what TWO back-to-back 30-minute rows bill, on every
// money pipeline. Only the row count differs, by exactly one.
//
//   Scenario X = one 60-minute row, Weight Room 1, 10:00-11:00.
//   Scenario Y = two back-to-back 30-minute rows on the same spot,
//                10:00-10:30 and 10:30-11:00.
//
// Each pipeline is entered at its TOP, with real rows in the database, so the
// code that turns rows into money is the code under test:
//   1. Reports aggregate and Excel: fetchReportData -> buildReportWorkbook,
//      composed exactly as /admin/reports/download does it, and the workbook
//      is read back cell by cell (blank cells included).
//   2. Statements: fetchStatementCoaches -> buildStatementPair.
//   3. De-identified export: computeAggregates.
//   4. Overdue balances: loadOverdueBalances.
//
// How this file is built:
//   - Every rental is written with a direct INSERT. The 30-minute pair has to
//     be: the create path now refuses a lone 30-minute weight room row, and a
//     batch would join the pair into one row.
//   - The stored rate is a distinctive 450 per half hour ($9.00 per hour), so
//     "$9.00 for the hour" cannot be confused with any default (the test
//     database's weight room default is 700, and `rate_defaults` is never read
//     or touched here).
//   - This file makes its OWN coaches (uniqueSuffix) and its own days, picked
//     at random far in the past. Every query and assertion is scoped to those
//     coaches and those days, so leftovers from other suites cannot leak in.
//     It does NOT truncate anything. afterAll deletes every row it wrote, rows
//     that reference a user before the users.
//   - Each pipeline gets its own days, so its fixture can be broken on purpose
//     without touching another pipeline's (the "teeth" runs).

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import { and, eq, gte, inArray, lt } from "drizzle-orm";
import { db } from "@/db";
import { coachPayments, sessionsBilling, users } from "@/db/schema";
import { computeAggregates } from "@/lib/data-safe/aggregate";
import { K_DEFAULT } from "@/lib/data-safe/anonymize";
import type { OpFact } from "@/lib/data-safe/types";
import type { ReportData } from "@/lib/reports/aggregate";
import { buildReportWorkbook } from "@/lib/reports/excel";
import { fetchReportData } from "@/lib/reports/fetch";
import type { NormalizedFilters } from "@/lib/reports/filters";
import { fetchHourLogRowsWithScheduleNotes } from "@/lib/reports/hour-log-fetch";
import { hourLogFiltersFromReportFilters } from "@/lib/reports/hour-log-filters";
import { buildPaymentTimeline } from "@/lib/reports/payments-timeline";
import { fetchPaymentTimelineRows } from "@/lib/reports/payments-timeline-fetch";
import { buildWorkReport } from "@/lib/reports/work-report";
import {
  loadOverdueBalances,
  type OverdueRow,
} from "@/lib/server/accountability-data";
import { buildStatementPair } from "@/lib/statement/engine";
import { fetchStatementCoaches } from "@/lib/statement/fetch";
import type { StatementPair } from "@/lib/statement/types";
import { fetchStipendEarningsInRange } from "@/lib/stipend/fetch";
import { coachScopeFromFilters } from "@/lib/stipend/scope";
import { formatPfaDate, parsePfaInput } from "@/lib/timezone";
import {
  ensureFixtureUsers,
  getSeededResources,
  type FixtureUsers,
} from "./fixtures";

// Several of these modules pull in @/db -> @/auth -> next-auth, which does not
// resolve in the vitest node environment. Nothing here exercises auth.
vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

type Row = typeof sessionsBilling.$inferSelect;

// 450 cents per half hour = $9.00 per hour.
const RATE = 450;
const HOUR_CENTS = 2 * RATE; // 900

let fixtures: FixtureUsers;
let seeded: Awaited<ReturnType<typeof getSeededResources>>;
let coachId: string; // reports, statements, data-safe
let fillerCoachId: string; // data-safe background rows only
let overdueCoachId: string; // overdue balances only
const createdUserIds: string[] = [];

// ── days ─────────────────────────────────────────────────────────────────

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const DAY_MS = 86_400_000;

// A random PFA day between ~400 and ~2,400 days ago, picked once per run: far
// from every "today"-relative fixture in the other suites, away from the fixed
// March 2025 week data-safe.test.ts uses, and different on every run so a
// crashed earlier run cannot leave rows on the same spot and time.
const BASE_DAY = formatPfaDate(
  new Date(Date.now() - (400 + Math.floor(Math.random() * 2000)) * DAY_MS),
);

// The PFA day `n` days after BASE_DAY. Stepped from noon, so a daylight saving
// change can never land it on the wrong calendar day.
function day(n: number): string {
  return formatPfaDate(
    new Date(parsePfaInput(BASE_DAY, "12:00").getTime() + n * DAY_MS),
  );
}

function at(d: string, time: string): Date {
  return parsePfaInput(d, time);
}

// One PFA calendar day as the half-open instants every pipeline takes.
function windowOf(d: string): { fromDate: Date; toDateExclusive: Date } {
  const fromDate = at(d, "00:00");
  const toDateExclusive = new Date(
    parsePfaInput(d, "12:00").getTime() + DAY_MS,
  );
  return {
    fromDate,
    toDateExclusive: at(formatPfaDate(toDateExclusive), "00:00"),
  };
}

// Each pipeline's own days. X and Y sit on different days so both can exist
// at once for the pipelines that take a date window.
const REPORTS_X_DAY = day(0);
const REPORTS_Y_DAY = day(1);
const STATEMENT_X_DAY = day(3);
const STATEMENT_Y_DAY = day(4);
const DATA_SAFE_X_DAY = day(6);
const DATA_SAFE_Y_DAY = day(7);
const OVERDUE_DAY = day(9);

// ── seeding ──────────────────────────────────────────────────────────────

async function seedRow(opts: {
  coachId: string;
  resourceId: string;
  day: string;
  start: string;
  end: string;
  rate: number;
}): Promise<Row> {
  const [row] = await db
    .insert(sessionsBilling)
    .values({
      coachId: opts.coachId,
      resourceId: opts.resourceId,
      startAt: at(opts.day, opts.start),
      endAt: at(opts.day, opts.end),
      ratePer30MinCents: opts.rate,
      isGroupSession: false,
      createdBy: fixtures.admin.id,
    })
    .returning();
  // What the INSERT returned is what the pipelines will read.
  expect(row.ratePer30MinCents).toBe(opts.rate);
  return row;
}

// Scenario X: ONE 60-minute row.
async function seedX(c: string, d: string, rate: number): Promise<Row[]> {
  return [
    await seedRow({
      coachId: c,
      resourceId: seeded.weightRoom1.id,
      day: d,
      start: "10:00",
      end: "11:00",
      rate,
    }),
  ];
}

// Scenario Y: TWO back-to-back 30-minute rows on the same spot.
async function seedY(
  c: string,
  d: string,
  firstRate: number,
  secondRate: number,
): Promise<Row[]> {
  return [
    await seedRow({
      coachId: c,
      resourceId: seeded.weightRoom1.id,
      day: d,
      start: "10:00",
      end: "10:30",
      rate: firstRate,
    }),
    await seedRow({
      coachId: c,
      resourceId: seeded.weightRoom1.id,
      day: d,
      start: "10:30",
      end: "11:00",
      rate: secondRate,
    }),
  ];
}

function minutesOf(rows: Row[]): number {
  return rows.reduce(
    (sum, r) => sum + (r.endAt.getTime() - r.startAt.getTime()) / 60_000,
    0,
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The rows a coach has on one day, re-read until there are `expected` of them
// (the Neon HTTP driver can miss a row written a moment ago). Returns the last
// read either way; the caller's assertion then fails honestly.
async function rowsOnDay(
  coach: string,
  d: string,
  expected: number,
): Promise<Row[]> {
  const w = windowOf(d);
  let rows: Row[] = [];
  for (let attempt = 0; attempt < 8; attempt++) {
    rows = await db
      .select()
      .from(sessionsBilling)
      .where(
        and(
          eq(sessionsBilling.coachId, coach),
          gte(sessionsBilling.startAt, w.fromDate),
          lt(sessionsBilling.startAt, w.toDateExclusive),
        ),
      );
    if (rows.length === expected) return rows;
    await sleep(250);
  }
  return rows;
}

// ── setup / teardown ─────────────────────────────────────────────────────

beforeAll(async () => {
  fixtures = await ensureFixtureUsers();
  seeded = await getSeededResources();

  const suffix = uniqueSuffix();
  const made = await db
    .insert(users)
    .values([
      {
        email: `money-eq-coach-${suffix}@test.invalid`,
        name: `Money Equivalence Coach ${suffix}`,
        role: "coach",
      },
      {
        email: `money-eq-filler-${suffix}@test.invalid`,
        name: `Money Equivalence Filler ${suffix}`,
        role: "coach",
      },
      {
        email: `money-eq-overdue-${suffix}@test.invalid`,
        name: `Money Equivalence Overdue ${suffix}`,
        role: "coach",
      },
    ])
    .returning({ id: users.id, email: users.email });
  const byPrefix = (p: string) => made.find((u) => u.email.startsWith(p))!.id;
  coachId = byPrefix("money-eq-coach-");
  fillerCoachId = byPrefix("money-eq-filler-");
  overdueCoachId = byPrefix("money-eq-overdue-");
  createdUserIds.push(coachId, fillerCoachId, overdueCoachId);
});

afterAll(async () => {
  if (createdUserIds.length === 0) return;
  // Rows that reference the users go first. These coaches never act, so no
  // audit_log row names them as the actor.
  await db
    .delete(sessionsBilling)
    .where(inArray(sessionsBilling.coachId, createdUserIds));
  await db
    .delete(coachPayments)
    .where(inArray(coachPayments.coachId, createdUserIds));
  await db.delete(users).where(inArray(users.id, createdUserIds));

  // Prove the cleanup landed rather than assume it.
  let left = -1;
  for (let attempt = 0; attempt < 8 && left !== 0; attempt++) {
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, createdUserIds));
    left = rows.length;
    if (left !== 0) await sleep(250);
  }
  expect(left, "this file's coaches are deleted").toBe(0);
});

// ── 1. reports aggregate and Excel ───────────────────────────────────────

function reportFilters(d: string): NormalizedFilters {
  const w = windowOf(d);
  return {
    from: d,
    to: d,
    fromDate: w.fromDate,
    toDateExclusive: w.toDateExclusive,
    coachIds: [coachId],
    resourceTypes: [],
  };
}

// Exactly the composition in src/app/admin/reports/download/route.ts.
async function reportAndWorkbook(
  filters: NormalizedFilters,
): Promise<{ report: ReportData; wb: ExcelJS.Workbook }> {
  const [report, workRows, paymentRows, stipendEarnings] = await Promise.all([
    fetchReportData(filters),
    fetchHourLogRowsWithScheduleNotes(hourLogFiltersFromReportFilters(filters)),
    fetchPaymentTimelineRows({
      fromDate: filters.fromDate,
      toDateExclusive: filters.toDateExclusive,
      coachIds: filters.coachIds,
    }),
    fetchStipendEarningsInRange({
      fromDate: filters.fromDate,
      toDateExclusive: filters.toDateExclusive,
      coachIds: coachScopeFromFilters(filters.coachIds),
    }),
  ]);
  const buffer = await buildReportWorkbook(
    {
      report,
      work: buildWorkReport(workRows, stipendEarnings),
      payments: buildPaymentTimeline(paymentRows.rows),
      paymentsTruncated: paymentRows.truncated,
    },
    { from: filters.from, to: filters.to },
  );
  const wb = new ExcelJS.Workbook();
  // ExcelJS's .load type signature predates modern Node Buffer generics.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await wb.xlsx.load(buffer as any);
  return { report, wb };
}

// Every row of a sheet as an array of cell values, column 1 to the sheet's
// last column, BLANK CELLS INCLUDED (getCell never skips a column, so a blank
// can never shift the columns after it). Index 0 is the header row.
function sheetRows(sheet: ExcelJS.Worksheet): unknown[][] {
  const out: unknown[][] = [];
  for (let r = 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const cells: unknown[] = [];
    for (let c = 1; c <= sheet.columnCount; c++) {
      cells.push(row.getCell(c).value);
    }
    out.push(cells);
  }
  return out;
}

function columnIndex(header: unknown[], name: string): number {
  const i = header.indexOf(name);
  expect(i, `column "${name}" in the header`).toBeGreaterThanOrEqual(0);
  return i;
}

function sumColumn(rows: unknown[][], i: number): number {
  return rows.reduce((sum, r) => sum + (r[i] as number), 0);
}

describe("1. reports aggregate and Excel (fetchReportData -> buildReportWorkbook)", () => {
  let x: { report: ReportData; wb: ExcelJS.Workbook };
  let y: { report: ReportData; wb: ExcelJS.Workbook };

  beforeAll(async () => {
    const xRows = await seedX(coachId, REPORTS_X_DAY, RATE);
    const yRows = await seedY(coachId, REPORTS_Y_DAY, RATE, RATE);
    expect(minutesOf(xRows)).toBe(60);
    expect(minutesOf(yRows)).toBe(60);
    expect(await rowsOnDay(coachId, REPORTS_X_DAY, 1)).toHaveLength(1);
    expect(await rowsOnDay(coachId, REPORTS_Y_DAY, 2)).toHaveLength(2);

    x = await reportAndWorkbook(reportFilters(REPORTS_X_DAY));
    y = await reportAndWorkbook(reportFilters(REPORTS_Y_DAY));
  });

  it("the aggregate: same dollars and half-hours, one detail row against two", () => {
    expect(x.report.grandTotalCents).toBe(HOUR_CENTS);
    expect(y.report.grandTotalCents).toBe(x.report.grandTotalCents);

    expect(x.report.summary).toHaveLength(1);
    expect(y.report.summary).toHaveLength(1);
    const xs = x.report.summary[0];
    const ys = y.report.summary[0];
    expect(xs.coachId).toBe(coachId);
    expect(xs.weightRoomTotalCents).toBe(HOUR_CENTS);
    expect(xs.weightRoomSlots).toBe(2);
    expect(xs.totalCents).toBe(HOUR_CENTS);
    // The whole per-coach summary line is identical, field for field.
    expect(ys).toEqual(xs);

    const xSlots = x.report.detail.reduce((s, r) => s + r.slots, 0);
    const ySlots = y.report.detail.reduce((s, r) => s + r.slots, 0);
    expect(xSlots).toBe(2);
    expect(ySlots).toBe(xSlots);
    const yCents = y.report.detail.reduce((s, r) => s + r.totalCents, 0);
    expect(yCents).toBe(x.report.detail[0].totalCents);

    expect(x.report.detail).toHaveLength(1);
    expect(y.report.detail).toHaveLength(2);
    expect(y.report.detail.length - x.report.detail.length).toBe(1);
  });

  it("the workbook's Cage Summary: the coach's line is identical cell for cell; the grand total differs only in its session count, by one", () => {
    const xr = sheetRows(x.wb.getWorksheet("Cage Summary")!);
    const yr = sheetRows(y.wb.getWorksheet("Cage Summary")!);
    // Header, the coach, the grand total.
    expect(xr).toHaveLength(3);
    expect(yr).toHaveLength(3);
    const header = xr[0];
    expect(yr[0]).toEqual(header);

    const wrSlots = columnIndex(header, "WeightRoom Slots");
    const wrDollars = columnIndex(header, "WeightRoom $");
    const owed = columnIndex(header, "Rental Owed $");
    expect(xr[1][wrSlots]).toBe(2);
    expect(xr[1][wrDollars]).toBe(HOUR_CENTS / 100);
    expect(xr[1][owed]).toBe(HOUR_CENTS / 100);
    expect(yr[1]).toEqual(xr[1]);

    // Grand total row: every cell but the label is the same.
    expect(xr[2][owed]).toBe(HOUR_CENTS / 100);
    expect(yr[2].slice(1)).toEqual(xr[2].slice(1));
    expect(xr[2][0]).toBe("Grand total (1 sessions)");
    expect(yr[2][0]).toBe("Grand total (2 sessions)");
  });

  it("the workbook's Cage Detail: one line against two, same minutes, half-hours, rate and dollars", () => {
    const xr = sheetRows(x.wb.getWorksheet("Cage Detail")!);
    const yr = sheetRows(y.wb.getWorksheet("Cage Detail")!);
    const header = xr[0];
    expect(yr[0]).toEqual(header);
    const xBody = xr.slice(1);
    const yBody = yr.slice(1);
    expect(xBody).toHaveLength(1);
    expect(yBody).toHaveLength(2);
    expect(yBody.length - xBody.length).toBe(1);

    const duration = columnIndex(header, "Duration (min)");
    const slots = columnIndex(header, "Slots");
    const rate = columnIndex(header, "Rate");
    const basis = columnIndex(header, "Rate basis");
    const dollars = columnIndex(header, "$");

    expect(sumColumn(xBody, duration)).toBe(60);
    expect(sumColumn(yBody, duration)).toBe(60);
    expect(sumColumn(xBody, slots)).toBe(2);
    expect(sumColumn(yBody, slots)).toBe(2);
    expect(sumColumn(xBody, dollars)).toBe(HOUR_CENTS / 100);
    expect(sumColumn(yBody, dollars)).toBe(HOUR_CENTS / 100);
    // The same quoted rate on every line: $9.00 per hour.
    for (const r of [...xBody, ...yBody]) {
      expect(r[rate]).toBe(HOUR_CENTS / 100);
      expect(r[basis]).toBe("per hr");
    }
  });
});

// ── 2. statements ────────────────────────────────────────────────────────

describe("2. statements (fetchStatementCoaches -> buildStatementPair)", () => {
  let x: StatementPair;
  let y: StatementPair;

  beforeAll(async () => {
    await seedX(coachId, STATEMENT_X_DAY, RATE);
    await seedY(coachId, STATEMENT_Y_DAY, RATE, RATE);
    expect(await rowsOnDay(coachId, STATEMENT_X_DAY, 1)).toHaveLength(1);
    expect(await rowsOnDay(coachId, STATEMENT_Y_DAY, 2)).toHaveLength(2);

    const coaches = await fetchStatementCoaches({ coachIds: [coachId] });
    expect(coaches).toHaveLength(1);
    const c = coaches[0];
    // The statement is ALL-TIME for the coach; the period is what places a
    // charge. X's period holds only X and Y's period holds only Y.
    const pairFor = (d: string) =>
      buildStatementPair({
        coachName: c.coachName,
        coachEmail: c.coachEmail,
        period: windowOf(d),
        cageCharges: c.cageCharges,
        workCharges: c.workCharges,
        payments: c.payments,
      });
    x = pairFor(STATEMENT_X_DAY);
    y = pairFor(STATEMENT_Y_DAY);
  });

  it("charges this period: same dollars, and the period moves the balance by the same amount", () => {
    expect(x.cage.chargesCents).toBe(HOUR_CENTS);
    expect(y.cage.chargesCents).toBe(x.cage.chargesCents);
    expect(x.cage.paymentsCents).toBe(0);
    expect(y.cage.paymentsCents).toBe(0);
    expect(x.cage.closingCents - x.cage.openingCents).toBe(HOUR_CENTS);
    expect(y.cage.closingCents - y.cage.openingCents).toBe(HOUR_CENTS);
  });

  it("the summary line is identical: same label, same half-hours and hours, same dollars", () => {
    expect(x.cage.chargeLines).toHaveLength(1);
    expect(x.cage.chargeLines[0].amountCents).toBe(HOUR_CENTS);
    expect(x.cage.chargeLines[0].units).toBe("2 slots · 1.0 h");
    expect(y.cage.chargeLines).toEqual(x.cage.chargeLines);
  });

  it("the itemized charges: one line against two, same half-hours and dollars", () => {
    expect(x.cage.chargeRows).toHaveLength(1);
    expect(y.cage.chargeRows).toHaveLength(2);
    expect(y.cage.chargeRows.length - x.cage.chargeRows.length).toBe(1);

    const slots = (p: StatementPair) =>
      p.cage.chargeRows.reduce((s, r) => s + (r.slots ?? 0), 0);
    const cents = (p: StatementPair) =>
      p.cage.chargeRows.reduce((s, r) => s + r.amountCents, 0);
    expect(slots(x)).toBe(2);
    expect(slots(y)).toBe(2);
    expect(cents(x)).toBe(HOUR_CENTS);
    expect(cents(y)).toBe(HOUR_CENTS);
    // Same quoted rate on every line.
    for (const r of [...x.cage.chargeRows, ...y.cage.chargeRows]) {
      expect(r.rateLabel).toBe(x.cage.chargeRows[0].rateLabel);
    }
  });
});

// ── 3. de-identified export ──────────────────────────────────────────────

// The export drops a cell whose count is under k = 5 (anonymize.ts). The
// weight room cell is what this pipeline says about these rentals, so the
// scenario is made big enough that it is NOT suppressed: 4 identical one-hour
// background rows (another coach, Weight Room 2) on both days. X's day then
// has 5 weight room bookings and Y's has 6, both at or over k, and the
// difference is still exactly the one extra row. The real k is used, not a
// lowered one, so the cell is asserted after suppression, as it is exported.
const FILLER_HOURS = ["12:00", "13:00", "14:00", "15:00"];

async function seedFiller(d: string): Promise<void> {
  for (const start of FILLER_HOURS) {
    const h = Number(start.slice(0, 2)) + 1;
    await seedRow({
      coachId: fillerCoachId,
      resourceId: seeded.weightRoom2.id,
      day: d,
      start,
      end: `${h}:00`,
      rate: RATE,
    });
  }
}

function fact(
  facts: OpFact[],
  metric: string,
  dims?: Record<string, string>,
): OpFact | undefined {
  return facts.find(
    (f) =>
      f.metric === metric &&
      (dims === undefined
        ? f.dims === undefined || f.dims === null
        : JSON.stringify(f.dims) === JSON.stringify(dims)),
  );
}

describe("3. de-identified export (computeAggregates)", () => {
  let x: OpFact[];
  let y: OpFact[];

  // The export is facility-wide for its window, so before trusting it, prove
  // the window holds ONLY this file's rows.
  async function onlyOurRowsIn(d: string, expected: number): Promise<void> {
    const w = windowOf(d);
    let rows: Row[] = [];
    for (let attempt = 0; attempt < 8; attempt++) {
      rows = await db
        .select()
        .from(sessionsBilling)
        .where(
          and(
            gte(sessionsBilling.startAt, w.fromDate),
            lt(sessionsBilling.startAt, w.toDateExclusive),
          ),
        );
      if (rows.length === expected) break;
      await sleep(250);
    }
    expect(rows).toHaveLength(expected);
    for (const r of rows) {
      expect([coachId, fillerCoachId]).toContain(r.coachId);
    }
  }

  beforeAll(async () => {
    await seedX(coachId, DATA_SAFE_X_DAY, RATE);
    await seedFiller(DATA_SAFE_X_DAY);
    await seedY(coachId, DATA_SAFE_Y_DAY, RATE, RATE);
    await seedFiller(DATA_SAFE_Y_DAY);
    await onlyOurRowsIn(DATA_SAFE_X_DAY, 1 + FILLER_HOURS.length);
    await onlyOurRowsIn(DATA_SAFE_Y_DAY, 2 + FILLER_HOURS.length);

    const run = (d: string) => {
      const w = windowOf(d);
      return computeAggregates(db, {
        periodStart: w.fromDate,
        periodEnd: w.toDateExclusive,
        salt: "money-equivalence",
        k: K_DEFAULT,
      });
    };
    x = await run(DATA_SAFE_X_DAY);
    y = await run(DATA_SAFE_Y_DAY);
  });

  it("revenue: identical dollars", () => {
    const expected = HOUR_CENTS * (1 + FILLER_HOURS.length);
    expect(fact(x, "cage_revenue_cents")?.value).toBe(expected);
    expect(fact(y, "cage_revenue_cents")?.value).toBe(expected);
  });

  it("booked time: identical utilization, facility-wide and for the weight room (the export carries no half-hour count; this is the figure built from it)", () => {
    const xu = fact(x, "utilization_pct");
    const yu = fact(y, "utilization_pct");
    expect(xu).toBeDefined();
    expect(yu?.value).toBe(xu!.value);

    const wrDims = { resource_type: "weight_room" };
    const xwr = fact(x, "utilization_pct", wrDims);
    const ywr = fact(y, "utilization_pct", wrDims);
    expect(xwr, "weight room utilization cell (not suppressed)").toBeDefined();
    expect(ywr?.value).toBe(xwr!.value);
    expect(xwr!.value).toBeGreaterThan(0);
  });

  it("booking counts: the weight room cell is exported on both days and differs by exactly one", () => {
    const xs = fact(x, "bookings_count");
    const ys = fact(y, "bookings_count");
    expect(xs?.value).toBe(1 + FILLER_HOURS.length);
    expect(ys?.value).toBe(2 + FILLER_HOURS.length);
    expect(ys!.value - xs!.value).toBe(1);

    const wrDims = { resource_type: "weight_room" };
    const xwr = fact(x, "bookings_count", wrDims);
    const ywr = fact(y, "bookings_count", wrDims);
    expect(xwr?.value).toBe(1 + FILLER_HOURS.length);
    expect(ywr?.value).toBe(2 + FILLER_HOURS.length);
    expect(ywr!.value - xwr!.value).toBe(1);
  });
});

// ── 4. overdue balances ──────────────────────────────────────────────────

// loadOverdueBalances has no date window: it is the coach's whole history. So
// X and Y for the same coach cannot exist at once. They run one after the
// other on the same day: seed X, read, delete X, seed Y, read, delete Y.
// `now` is pinned 40 days after the rentals, so the coach is overdue by age
// (more than 30 days) and the day count is deterministic.
describe("4. overdue balances (loadOverdueBalances)", () => {
  const now = new Date(at(OVERDUE_DAY, "10:00").getTime() + 40 * DAY_MS + 6 * 3_600_000);

  async function overdueRowFor(): Promise<OverdueRow | undefined> {
    const result = await loadOverdueBalances({ now });
    return result.rows.find((r) => r.coachId === overdueCoachId);
  }

  async function clearOverdueCoach(): Promise<void> {
    await db
      .delete(sessionsBilling)
      .where(eq(sessionsBilling.coachId, overdueCoachId));
    await db
      .delete(coachPayments)
      .where(eq(coachPayments.coachId, overdueCoachId));
    expect(await rowsOnDay(overdueCoachId, OVERDUE_DAY, 0)).toHaveLength(0);
  }

  async function runBoth(seedPayment?: () => Promise<void>) {
    await clearOverdueCoach();
    if (seedPayment) await seedPayment();
    await seedX(overdueCoachId, OVERDUE_DAY, RATE);
    expect(await rowsOnDay(overdueCoachId, OVERDUE_DAY, 1)).toHaveLength(1);
    const x = await overdueRowFor();

    await db
      .delete(sessionsBilling)
      .where(eq(sessionsBilling.coachId, overdueCoachId));
    expect(await rowsOnDay(overdueCoachId, OVERDUE_DAY, 0)).toHaveLength(0);

    await seedY(overdueCoachId, OVERDUE_DAY, RATE, RATE);
    expect(await rowsOnDay(overdueCoachId, OVERDUE_DAY, 2)).toHaveLength(2);
    const y = await overdueRowFor();

    await clearOverdueCoach();
    return { x, y };
  }

  it("nothing paid: same balance, same oldest unpaid rental, same age, same reasons (this pipeline reports no rental count)", async () => {
    const { x, y } = await runBoth();
    expect(x, "X is listed as overdue").toBeDefined();
    expect(y, "Y is listed as overdue").toBeDefined();

    expect(x!.balanceCents).toBe(HOUR_CENTS);
    expect(y!.balanceCents).toBe(x!.balanceCents);
    expect(x!.oldestUnpaidAt?.getTime()).toBe(
      at(OVERDUE_DAY, "10:00").getTime(),
    );
    expect(y!.oldestUnpaidAt?.getTime()).toBe(x!.oldestUnpaidAt?.getTime());
    expect(x!.oldestUnpaidDays).toBe(40);
    expect(y!.oldestUnpaidDays).toBe(x!.oldestUnpaidDays);
    expect(x!.reasons).toEqual(["age"]);
    expect(y!.reasons).toEqual(x!.reasons);
  });

  // FOUND ON THE WAY, pinned so it is seen: with a payment that covers exactly
  // one half-hour, the DOLLARS still match, but the oldest unpaid rental is a
  // different instant. The aging walk pays off whole rentals oldest first, so
  // under Y the payment clears the 10:00 half and the oldest unpaid one starts
  // at 10:30, while under X the single row is only part-paid and stays at
  // 10:00. The day count shown on screen is the same (40) unless the 30
  // minutes straddle a day boundary relative to "now".
  it("a payment covering one half-hour: same balance and reasons; the oldest unpaid instant moves by 30 minutes under Y", async () => {
    const { x, y } = await runBoth(async () => {
      await db.insert(coachPayments).values({
        coachId: overdueCoachId,
        amountCents: RATE,
        method: "cash",
        direction: "coach_to_pfa",
        paidAt: at(OVERDUE_DAY, "18:00"),
        status: "confirmed",
        recordedBy: fixtures.admin.id,
        confirmedBy: fixtures.admin.id,
        confirmedAt: at(OVERDUE_DAY, "18:00"),
      });
    });
    expect(x).toBeDefined();
    expect(y).toBeDefined();

    expect(x!.balanceCents).toBe(HOUR_CENTS - RATE);
    expect(y!.balanceCents).toBe(x!.balanceCents);
    expect(y!.reasons).toEqual(x!.reasons);
    expect(x!.oldestUnpaidDays).toBe(40);
    expect(y!.oldestUnpaidDays).toBe(x!.oldestUnpaidDays);

    expect(x!.oldestUnpaidAt?.getTime()).toBe(
      at(OVERDUE_DAY, "10:00").getTime(),
    );
    expect(y!.oldestUnpaidAt?.getTime()).toBe(
      at(OVERDUE_DAY, "10:30").getTime(),
    );
  });
});
