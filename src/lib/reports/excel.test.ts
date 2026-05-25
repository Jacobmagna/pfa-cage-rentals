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
        totalCents: 3600,
        note: "warm-up",
        isTeamRental: false,
        pfaReferred: true,
        isOnline: false,
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
        ratePerSlotCents: 700,
        totalCents: 1400,
        note: null,
        isTeamRental: true,
        pfaReferred: false,
        isOnline: false,
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
        useType: "hitting",
        ratePerSlotCents: 0,
        totalCents: 0,
        note: null,
        isTeamRental: false,
        pfaReferred: false,
        isOnline: true,
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
        totalCents: 3600,
        onlineSessions: 1,
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
        totalCents: 1400,
        onlineSessions: 0,
      },
    ],
    grandTotalCents: 5000,
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
    expect(buf.length).toBeGreaterThan(2000);

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
        "Online Sessions",
      ]);
    });

    it("renders dollar values divided by 100 with currency numFmt", async () => {
      const buf = await buildReportWorkbook(makeReport(), {
        from: "2026-05-01",
        to: "2026-05-31",
      });
      const wb = await loadWorkbook(buf);
      const sheet = wb.getWorksheet("Summary")!;
      const row2 = sheet.getRow(2);
      expect(row2.getCell(1).value).toBe("Alice Coach");
      expect(row2.getCell(4).value).toBe(36); // cage $ = 3600 cents / 100
      expect(row2.getCell(9).value).toBe(36); // total
      expect(row2.getCell(10).value).toBe(1); // 1 online session

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
      expect(sheet.rowCount).toBe(4); // 1 header + 2 coach rows + 1 footer
      const footer = sheet.getRow(4);
      expect(String(footer.getCell(1).value)).toContain("Grand total");
      expect(String(footer.getCell(1).value)).toContain("3 sessions");
      expect(footer.getCell(9).value).toBe(50); // 5000 cents / 100
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
      expect(sheet.rowCount).toBe(4); // header + 3 sessions
    });

    // Detail column layout (1-based) after the rate-snapshot refactor:
    //   1 Date · 2 Day · 3 Start · 4 End · 5 Duration · 6 Resource
    //   7 Use · 8 Coach · 9 Team Rental · 10 PFA-Referred · 11 Online
    //   12 Slots · 13 Rate · 14 $ · 15 Note
    it("writes flags + dollar amounts per session", async () => {
      const buf = await buildReportWorkbook(makeReport(), {
        from: "2026-05-01",
        to: "2026-05-31",
      });
      const wb = await loadWorkbook(buf);
      const sheet = wb.getWorksheet("Detail")!;

      const row2 = sheet.getRow(2);
      expect(row2.getCell(1).value).toBe("2026-05-05");
      expect(row2.getCell(6).value).toBe("Cage 1");
      expect(row2.getCell(8).value).toBe("Alice Coach");
      const teamRentalVal2 = row2.getCell(9).value;
      expect(teamRentalVal2 === "" || teamRentalVal2 === null).toBe(true);
      expect(row2.getCell(10).value).toBe("Yes"); // pfa-referred
      const onlineVal2 = row2.getCell(11).value;
      expect(onlineVal2 === "" || onlineVal2 === null).toBe(true);
      expect(row2.getCell(12).value).toBe(2);
      expect(row2.getCell(13).value).toBe(18); // 1800 / 100
      expect(row2.getCell(14).value).toBe(36);
      expect(row2.getCell(15).value).toBe("warm-up");

      const row4 = sheet.getRow(4); // s3 — online session
      expect(row4.getCell(11).value).toBe("Yes"); // online
      expect(row4.getCell(13).value).toBe(0); // rate 0
      expect(row4.getCell(14).value).toBe(0); // total 0
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
    expect(summary.rowCount).toBe(1);
    const detail = wb.getWorksheet("Detail")!;
    expect(detail.rowCount).toBe(1);
  });
});
