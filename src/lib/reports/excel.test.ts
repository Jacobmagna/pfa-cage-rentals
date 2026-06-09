// Round-trip tests for the workbook builder. Write a workbook via
// buildReportWorkbook, parse it back with ExcelJS, assert the
// structure + values match what aggregateReport produced.
//
// The point of these isn't to test ExcelJS itself — it's to lock
// down our cents→dollars conversion and the column layout that Dad
// emails out to coaches. If a column gets reordered or a numFmt
// drifts, this test fires.

import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildReportWorkbook } from "./excel";
import type { ReportData } from "./aggregate";

function makeReport(): ReportData {
  return {
    detail: [
      {
        sessionId: "s1",
        date: "2026-05-05",
        dayOfWeek: "Tue",
        startTime: "09:00",
        endTime: "10:00",
        durationMinutes: 60,
        slots: 2,
        resourceName: "Cage 1",
        resourceType: "cage",
        coachId: "c1",
        coachName: "Alice Coach",
        coachEmail: "alice@x.com",
        ratePerSlotCents: 1800,
        totalCents: 3600,
        note: "warm-up",
      },
      {
        sessionId: "s2",
        date: "2026-05-07",
        dayOfWeek: "Thu",
        startTime: "08:00",
        endTime: "09:00",
        durationMinutes: 60,
        slots: 2,
        resourceName: "Weight Room 1",
        resourceType: "weight_room",
        coachId: "c2",
        coachName: "Bob Coach",
        coachEmail: "bob@x.com",
        ratePerSlotCents: 700,
        totalCents: 1400,
        note: null,
      },
      {
        sessionId: "s3",
        date: "2026-05-08",
        dayOfWeek: "Fri",
        startTime: "10:00",
        endTime: "11:00",
        durationMinutes: 60,
        slots: 2,
        resourceName: "Cage 2",
        resourceType: "cage",
        coachId: "c1",
        coachName: "Alice Coach",
        coachEmail: "alice@x.com",
        ratePerSlotCents: 0,
        totalCents: 0,
        note: null,
      },
    ],
    summary: [
      {
        coachId: "c1",
        coachName: "Alice Coach",
        coachEmail: "alice@x.com",
        cageSlots: 4,
        cageTotalCents: 3600,
        bullpenSlots: 0,
        bullpenTotalCents: 0,
        weightRoomSlots: 0,
        weightRoomTotalCents: 0,
        programHours: 0,
        programTotalCents: 0,
        totalCents: 3600,
      },
      {
        coachId: "c2",
        coachName: "Bob Coach",
        coachEmail: "bob@x.com",
        cageSlots: 0,
        cageTotalCents: 0,
        bullpenSlots: 0,
        bullpenTotalCents: 0,
        weightRoomSlots: 2,
        weightRoomTotalCents: 1400,
        programHours: 0,
        programTotalCents: 0,
        totalCents: 1400,
      },
    ],
    grandTotalCents: 5000,
    programGrandTotalCents: 0,
  };
}

// Default scope = both categories on (the fresh-load default). Tests
// that exercise the scope gating pass explicit booleans instead.
const META = { from: "2026-05-01", to: "2026-05-31" } as const;
function build(
  report: ReportData,
  includeCage = true,
  includeProgram = true,
): Promise<Buffer> {
  return buildReportWorkbook(report, META, includeCage, includeProgram);
}

async function loadWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  // ExcelJS's .load type signature predates modern Node Buffer
  // generics (Buffer<ArrayBufferLike>); the runtime accepts the
  // buffer fine — escape hatch via `any` keeps the call sites clean.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await wb.xlsx.load(buffer as any);
  return wb;
}

describe("buildReportWorkbook", () => {
  it("produces a Buffer with both Summary and Detail sheets", async () => {
    const buf = await build(makeReport());
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(2000);

    const wb = await loadWorkbook(buf);
    expect(wb.worksheets.map((s) => s.name)).toEqual(["Summary", "Detail"]);
  });

  it("writes workbook metadata (creator + subject) from the inputs", async () => {
    const buf = await build(makeReport());
    const wb = await loadWorkbook(buf);
    expect(wb.creator).toBe("PFA Engine");
    expect(wb.subject).toBe("Billing 2026-05-01 to 2026-05-31");
  });

  describe("Summary sheet", () => {
    it("has the expected header columns in order", async () => {
      const buf = await build(makeReport());
      const wb = await loadWorkbook(buf);
      const sheet = wb.getWorksheet("Summary")!;
      const headers = sheet.getRow(1).values as unknown[];
      expect(headers.slice(1)).toEqual([
        "Coach",
        "Email",
        "Cage Slots",
        "Cage $",
        "Bullpen Slots",
        "Bullpen $",
        "WeightRoom Slots",
        "WeightRoom $",
        "Work Hours",
        "Work $",
        "Rental Owed $",
      ]);
    });

    it("renders dollar values divided by 100 with currency numFmt", async () => {
      const buf = await build(makeReport());
      const wb = await loadWorkbook(buf);
      const sheet = wb.getWorksheet("Summary")!;
      const row2 = sheet.getRow(2);
      expect(row2.getCell(1).value).toBe("Alice Coach");
      expect(row2.getCell(4).value).toBe(36); // cage $ = 3600 cents / 100
      expect(row2.getCell(11).value).toBe(36); // Rental Owed $ (cage receivable, col 11)

      expect(sheet.getColumn(4).numFmt).toBe('"$"#,##0.00');
      expect(sheet.getColumn(11).numFmt).toBe('"$"#,##0.00');
    });

    it("appends a bold grand-total footer row", async () => {
      const buf = await build(makeReport());
      const wb = await loadWorkbook(buf);
      const sheet = wb.getWorksheet("Summary")!;
      expect(sheet.rowCount).toBe(4); // 1 header + 2 coach rows + 1 footer
      const footer = sheet.getRow(4);
      expect(String(footer.getCell(1).value)).toContain("Grand total");
      expect(String(footer.getCell(1).value)).toContain("3 sessions");
      // Cage-side grand sits under "Rental Owed $" (col 11), NOT merged with
      // program pay. Work $ (col 10) holds the (here zero) program grand.
      expect(footer.getCell(11).value).toBe(50); // cage grand: 5000 cents / 100
      const programGrand = footer.getCell(10).value;
      expect(programGrand === 0 || programGrand === null || programGrand === "").toBe(true);
      expect(footer.font?.bold).toBe(true);
    });

    it("puts cage and program grand totals in SEPARATE columns, never summed", async () => {
      const report = makeReport();
      // Give a coach program pay so both grand totals are non-zero.
      report.summary[0].programHours = 2;
      report.summary[0].programTotalCents = 6000;
      report.programGrandTotalCents = 6000;
      const buf = await build(report, true, true);
      const wb = await loadWorkbook(buf);
      const sheet = wb.getWorksheet("Summary")!;
      const footer = sheet.getRow(4);
      // Work $ grand under col 10, Rental Owed $ grand under col 11 — the
      // two opposite money directions are reported side by side, not added.
      expect(footer.getCell(10).value).toBe(60); // program pay grand: 6000 / 100
      expect(footer.getCell(11).value).toBe(50); // cage receivable grand: 5000 / 100
    });

    it("freezes the header row", async () => {
      const buf = await build(makeReport());
      const wb = await loadWorkbook(buf);
      const sheet = wb.getWorksheet("Summary")!;
      const view = sheet.views?.[0];
      expect(view?.state).toBe("frozen");
      const ySplit = (view as { ySplit?: number } | undefined)?.ySplit;
      expect(ySplit).toBe(1);
    });

    it("drops the cage column groups (and Online) when cage scope is off", async () => {
      const buf = await build(makeReport(), false, true);
      const wb = await loadWorkbook(buf);
      const sheet = wb.getWorksheet("Summary")!;
      const headers = (sheet.getRow(1).values as unknown[]).slice(1);
      // Cage scope off → no cage columns AND no "Rental Owed $" / Online.
      expect(headers).toEqual([
        "Coach",
        "Email",
        "Work Hours",
        "Work $",
      ]);
      expect(headers).not.toContain("Rental Owed $");
      expect(headers).not.toContain("Online Sessions");
    });

    it("drops the program columns when program scope is off", async () => {
      const buf = await build(makeReport(), true, false);
      const wb = await loadWorkbook(buf);
      const sheet = wb.getWorksheet("Summary")!;
      const headers = (sheet.getRow(1).values as unknown[]).slice(1);
      expect(headers).toEqual([
        "Coach",
        "Email",
        "Cage Slots",
        "Cage $",
        "Bullpen Slots",
        "Bullpen $",
        "WeightRoom Slots",
        "WeightRoom $",
        "Rental Owed $",
      ]);
      expect(headers).not.toContain("Work Hours");
    });

    it("writes Work Hours/$ and applies currency format to Work $", async () => {
      const report = makeReport();
      report.summary[0].programHours = 1.5;
      report.summary[0].programTotalCents = 7500;
      const buf = await build(report, false, true);
      const wb = await loadWorkbook(buf);
      const sheet = wb.getWorksheet("Summary")!;
      // Columns: 1 Coach, 2 Email, 3 Work Hours, 4 Work $, 5 Total
      const row2 = sheet.getRow(2);
      expect(row2.getCell(3).value).toBe(1.5); // exact program hours
      expect(row2.getCell(4).value).toBe(75); // 7500 cents / 100
      expect(sheet.getColumn(4).numFmt).toBe('"$"#,##0.00');
    });
  });

  describe("Detail sheet", () => {
    it("has one row per session plus the header", async () => {
      const buf = await build(makeReport());
      const wb = await loadWorkbook(buf);
      const sheet = wb.getWorksheet("Detail")!;
      expect(sheet.rowCount).toBe(4); // header + 3 sessions
    });

    // Detail column layout (1-based) after the cage-flag removal:
    //   1 Date · 2 Day · 3 Start · 4 End · 5 Duration · 6 Resource
    //   7 Coach · 8 Slots · 9 Rate · 10 $ · 11 Note
    it("writes dollar amounts per session", async () => {
      const buf = await build(makeReport());
      const wb = await loadWorkbook(buf);
      const sheet = wb.getWorksheet("Detail")!;

      const row2 = sheet.getRow(2);
      expect(row2.getCell(1).value).toBe("2026-05-05");
      expect(row2.getCell(6).value).toBe("Cage 1");
      expect(row2.getCell(7).value).toBe("Alice Coach");
      expect(row2.getCell(8).value).toBe(2); // slots
      expect(row2.getCell(9).value).toBe(18); // 1800 / 100
      expect(row2.getCell(10).value).toBe(36);
      expect(row2.getCell(11).value).toBe("warm-up");

      const row4 = sheet.getRow(4); // s3 — zero-rate session
      expect(row4.getCell(9).value).toBe(0); // rate 0
      expect(row4.getCell(10).value).toBe(0); // total 0
    });
  });

  it("handles an empty report cleanly (no rows, no footer)", async () => {
    const empty: ReportData = {
      detail: [],
      summary: [],
      grandTotalCents: 0,
      programGrandTotalCents: 0,
    };
    const buf = await build(empty);
    const wb = await loadWorkbook(buf);
    const summary = wb.getWorksheet("Summary")!;
    expect(summary.rowCount).toBe(1);
    const detail = wb.getWorksheet("Detail")!;
    expect(detail.rowCount).toBe(1);
  });
});
