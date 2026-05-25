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
        useType: "hitting",
        ratePerSlotCents: 1800,
        rateSource: "override",
        totalCents: 3600,
        note: "warm-up",
        isTeamRental: false,
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
        useType: null,
        ratePerSlotCents: 500,
        rateSource: "default",
        totalCents: 1000,
        note: null,
        isTeamRental: true,
      },
    ],
    summary: [
      {
        coachId: "c1",
        coachName: "Alice Coach",
        coachEmail: "alice@x.com",
        cageSlots: 2,
        cageTotalCents: 3600,
        bullpenSlots: 0,
        bullpenTotalCents: 0,
        weightRoomSlots: 0,
        weightRoomTotalCents: 0,
        totalCents: 3600,
        appliedOverride: true,
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
        weightRoomTotalCents: 1000,
        totalCents: 1000,
        appliedOverride: false,
      },
    ],
    grandTotalCents: 4600,
  };
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
    const buf = await buildReportWorkbook(makeReport(), {
      from: "2026-05-01",
      to: "2026-05-31",
    });
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(2000); // a real .xlsx is never tiny

    const wb = await loadWorkbook(buf);
    expect(wb.worksheets.map((s) => s.name)).toEqual(["Summary", "Detail"]);
  });

  it("writes workbook metadata (creator + subject) from the inputs", async () => {
    const buf = await buildReportWorkbook(makeReport(), {
      from: "2026-05-01",
      to: "2026-05-31",
    });
    const wb = await loadWorkbook(buf);
    expect(wb.creator).toBe("PFA Cage Rentals");
    expect(wb.subject).toBe("Billing 2026-05-01 to 2026-05-31");
  });

  describe("Summary sheet", () => {
    it("has the expected header columns in order", async () => {
      const buf = await buildReportWorkbook(makeReport(), {
        from: "2026-05-01",
        to: "2026-05-31",
      });
      const wb = await loadWorkbook(buf);
      const sheet = wb.getWorksheet("Summary")!;
      const headers = sheet.getRow(1).values as unknown[];
      // values is 1-indexed; slice(1) drops the leading undefined.
      expect(headers.slice(1)).toEqual([
        "Coach",
        "Email",
        "Cage Slots",
        "Cage $",
        "Bullpen Slots",
        "Bullpen $",
        "WeightRoom Slots",
        "WeightRoom $",
        "Total",
        "Rate Source",
      ]);
    });

    // Summary column layout (1-based — Excel files don't persist
    // the `key` aliases we set in the builder, so we index by number
    // after a buffer round-trip):
    //   1 Coach · 2 Email · 3 Cage Slots · 4 Cage $ · 5 Bullpen Slots
    //   6 Bullpen $ · 7 WeightRoom Slots · 8 WeightRoom $ · 9 Total
    //   10 Rate Source
    it("renders dollar values divided by 100 with currency numFmt", async () => {
      const buf = await buildReportWorkbook(makeReport(), {
        from: "2026-05-01",
        to: "2026-05-31",
      });
      const wb = await loadWorkbook(buf);
      const sheet = wb.getWorksheet("Summary")!;
      // Row 2 = Alice (cage override $36)
      const row2 = sheet.getRow(2);
      expect(row2.getCell(1).value).toBe("Alice Coach");
      expect(row2.getCell(4).value).toBe(36); // cage $ = 3600 cents / 100
      expect(row2.getCell(9).value).toBe(36); // total
      expect(row2.getCell(10).value).toBe("Override");

      // Number format on the dollar columns.
      expect(sheet.getColumn(4).numFmt).toBe('"$"#,##0.00');
      expect(sheet.getColumn(9).numFmt).toBe('"$"#,##0.00');
    });

    it("appends a bold grand-total footer row", async () => {
      const buf = await buildReportWorkbook(makeReport(), {
        from: "2026-05-01",
        to: "2026-05-31",
      });
      const wb = await loadWorkbook(buf);
      const sheet = wb.getWorksheet("Summary")!;
      // 1 header + 2 coach rows + 1 footer = 4 rows
      expect(sheet.rowCount).toBe(4);
      const footer = sheet.getRow(4);
      expect(String(footer.getCell(1).value)).toContain("Grand total");
      expect(String(footer.getCell(1).value)).toContain("2 sessions");
      expect(footer.getCell(9).value).toBe(46); // total column
      expect(footer.font?.bold).toBe(true);
    });

    it("freezes the header row", async () => {
      const buf = await buildReportWorkbook(makeReport(), {
        from: "2026-05-01",
        to: "2026-05-31",
      });
      const wb = await loadWorkbook(buf);
      const sheet = wb.getWorksheet("Summary")!;
      const view = sheet.views?.[0];
      expect(view?.state).toBe("frozen");
      // ySplit only exists on the frozen-view variant of the union;
      // narrow via state, then read it as a number through a cast
      // that's safe given the assertion above.
      const ySplit = (view as { ySplit?: number } | undefined)?.ySplit;
      expect(ySplit).toBe(1);
    });
  });

  describe("Detail sheet", () => {
    it("has one row per session plus the header", async () => {
      const buf = await buildReportWorkbook(makeReport(), {
        from: "2026-05-01",
        to: "2026-05-31",
      });
      const wb = await loadWorkbook(buf);
      const sheet = wb.getWorksheet("Detail")!;
      // 1 header + 2 sessions = 3 rows (no grand-total in Detail)
      expect(sheet.rowCount).toBe(3);
    });

    // Detail column layout (1-based):
    //   1 Date · 2 Day · 3 Start · 4 End · 5 Duration · 6 Resource
    //   7 Use · 8 Coach · 9 Team Rental · 10 Slots · 11 Rate · 12 $
    //   13 Rate Source · 14 Note
    it("writes the override flag + dollar amounts per session", async () => {
      const buf = await buildReportWorkbook(makeReport(), {
        from: "2026-05-01",
        to: "2026-05-31",
      });
      const wb = await loadWorkbook(buf);
      const sheet = wb.getWorksheet("Detail")!;

      const row2 = sheet.getRow(2);
      expect(row2.getCell(1).value).toBe("2026-05-05");
      expect(row2.getCell(6).value).toBe("Cage 1");
      expect(row2.getCell(7).value).toBe("hitting");
      expect(row2.getCell(8).value).toBe("Alice Coach");
      const teamRentalVal2 = row2.getCell(9).value;
      expect(teamRentalVal2 === "" || teamRentalVal2 === null).toBe(true);
      expect(row2.getCell(10).value).toBe(2);
      expect(row2.getCell(11).value).toBe(18); // 1800 cents / 100
      expect(row2.getCell(12).value).toBe(36);
      expect(row2.getCell(13).value).toBe("Override");
      expect(row2.getCell(14).value).toBe("warm-up");

      const row3 = sheet.getRow(3);
      expect(row3.getCell(6).value).toBe("Weight Room 1");
      // null useType/note: ExcelJS represents an empty cell as
      // either "" or null depending on its codec path. Accept both.
      const useVal = row3.getCell(7).value;
      expect(useVal === "" || useVal === null).toBe(true);
      expect(row3.getCell(9).value).toBe("Yes"); // team rental
      expect(row3.getCell(13).value).toBe("Default");
      const noteVal = row3.getCell(14).value;
      expect(noteVal === "" || noteVal === null).toBe(true);
    });
  });

  it("handles an empty report cleanly (no rows, no footer)", async () => {
    const empty: ReportData = {
      detail: [],
      summary: [],
      grandTotalCents: 0,
    };
    const buf = await buildReportWorkbook(empty, {
      from: "2026-05-01",
      to: "2026-05-31",
    });
    const wb = await loadWorkbook(buf);
    const summary = wb.getWorksheet("Summary")!;
    // Header only, no coach rows, no footer.
    expect(summary.rowCount).toBe(1);
    const detail = wb.getWorksheet("Detail")!;
    expect(detail.rowCount).toBe(1);
  });
});
