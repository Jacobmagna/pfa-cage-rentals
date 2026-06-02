// Round-trip tests for the hour-log workbook builder. Write a workbook
// via buildHourLogWorkbook, parse it back with ExcelJS, assert the
// structure + values. Mirrors excel.test.ts.
//
// The point isn't to test ExcelJS — it's to lock down the hours
// computation, the per-coach Summary rollup, and that the Detail sheet
// is grouped by coach then date.

import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
  buildHourLogWorkbook,
  type HourLogWorkbookRow,
} from "./hour-log-excel";

// Two coaches, a few rows each, deliberately out of coach + date order
// so the builder's sort is exercised. Times are UTC instants; the
// hours math is TZ-independent (endAt − startAt).
function makeRows(): HourLogWorkbookRow[] {
  const d = (iso: string) => new Date(iso);
  return [
    {
      id: "h1",
      coachId: "c2",
      coachName: "Bob Coach",
      coachEmail: "bob@x.com",
      programId: "p2",
      programName: "Speed & Agility",
      startAt: d("2026-05-10T14:00:00Z"),
      endAt: d("2026-05-10T15:30:00Z"), // 1.5h
      note: "drills",
      scheduleNote: "Alice Coach was scheduled.",
    },
    {
      id: "h2",
      coachId: "c1",
      coachName: "Alice Coach",
      coachEmail: "alice@x.com",
      programId: "p1",
      programName: "Elite Hitting",
      startAt: d("2026-05-09T13:00:00Z"),
      endAt: d("2026-05-09T15:00:00Z"), // 2h
      note: null,
      scheduleNote: null,
    },
    {
      id: "h3",
      coachId: "c1",
      coachName: "Alice Coach",
      coachEmail: "alice@x.com",
      programId: "p1",
      programName: "Elite Hitting",
      startAt: d("2026-05-05T13:00:00Z"),
      endAt: d("2026-05-05T14:00:00Z"), // 1h
      note: "warm-up",
      scheduleNote: null,
    },
  ];
}

async function loadWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  // ExcelJS's .load type signature predates modern Node Buffer generics;
  // the runtime accepts the buffer fine.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await wb.xlsx.load(buffer as any);
  return wb;
}

describe("buildHourLogWorkbook", () => {
  it("produces a Buffer with both Summary and Detail sheets", async () => {
    const buf = await buildHourLogWorkbook(makeRows(), {
      from: "2026-05-01",
      to: "2026-05-31",
    });
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(2000);

    const wb = await loadWorkbook(buf);
    expect(wb.worksheets.map((s) => s.name)).toEqual(["Summary", "Detail"]);
  });

  it("writes workbook metadata (creator + subject) from the inputs", async () => {
    const buf = await buildHourLogWorkbook(makeRows(), {
      from: "2026-05-01",
      to: "2026-05-31",
    });
    const wb = await loadWorkbook(buf);
    expect(wb.creator).toBe("PFA Baseball");
    expect(wb.subject).toBe("Hours 2026-05-01 to 2026-05-31");
  });

  describe("Summary sheet", () => {
    it("has the expected header columns in order", async () => {
      const buf = await buildHourLogWorkbook(makeRows(), {
        from: "2026-05-01",
        to: "2026-05-31",
      });
      const wb = await loadWorkbook(buf);
      const sheet = wb.getWorksheet("Summary")!;
      const headers = sheet.getRow(1).values as unknown[];
      expect(headers.slice(1)).toEqual(["Coach", "Entries", "Total Hours"]);
    });

    it("has one row per coach with correct entry count + total hours", async () => {
      const buf = await buildHourLogWorkbook(makeRows(), {
        from: "2026-05-01",
        to: "2026-05-31",
      });
      const wb = await loadWorkbook(buf);
      const sheet = wb.getWorksheet("Summary")!;
      // 1 header + 2 coach rows
      expect(sheet.rowCount).toBe(3);

      // Sorted by coach label → Alice (c1) first, then Bob (c2).
      const alice = sheet.getRow(2);
      expect(alice.getCell(1).value).toBe("Alice Coach");
      expect(alice.getCell(2).value).toBe(2); // two entries
      expect(alice.getCell(3).value).toBe(3); // 2h + 1h = 3.00

      const bob = sheet.getRow(3);
      expect(bob.getCell(1).value).toBe("Bob Coach");
      expect(bob.getCell(2).value).toBe(1);
      expect(bob.getCell(3).value).toBe(1.5);

      expect(sheet.getColumn(3).numFmt).toBe("0.00");
    });

    it("freezes the header row", async () => {
      const buf = await buildHourLogWorkbook(makeRows(), {
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
    it("has one row per hour plus the header", async () => {
      const buf = await buildHourLogWorkbook(makeRows(), {
        from: "2026-05-01",
        to: "2026-05-31",
      });
      const wb = await loadWorkbook(buf);
      const sheet = wb.getWorksheet("Detail")!;
      expect(sheet.rowCount).toBe(4); // header + 3 rows
    });

    // Detail columns (1-based): 1 Coach · 2 Program · 3 Date · 4 Start
    //   · 5 End · 6 Hours · 7 Note · 8 Schedule
    it("has the expected header columns in order incl. Schedule", async () => {
      const buf = await buildHourLogWorkbook(makeRows(), {
        from: "2026-05-01",
        to: "2026-05-31",
      });
      const wb = await loadWorkbook(buf);
      const sheet = wb.getWorksheet("Detail")!;
      const headers = sheet.getRow(1).values as unknown[];
      expect(headers.slice(1)).toEqual([
        "Coach",
        "Program",
        "Date",
        "Start",
        "End",
        "Hours",
        "Note",
        "Schedule",
      ]);
    });

    it("is grouped by coach then date with correct hours", async () => {
      const buf = await buildHourLogWorkbook(makeRows(), {
        from: "2026-05-01",
        to: "2026-05-31",
      });
      const wb = await loadWorkbook(buf);
      const sheet = wb.getWorksheet("Detail")!;

      // Alice's two rows come first (grouped), in date order (05-05 then
      // 05-09), then Bob's single row.
      const r2 = sheet.getRow(2);
      expect(r2.getCell(1).value).toBe("Alice Coach");
      expect(r2.getCell(3).value).toBe("2026-05-05");
      expect(r2.getCell(6).value).toBe(1);
      expect(r2.getCell(7).value).toBe("warm-up");

      const r3 = sheet.getRow(3);
      expect(r3.getCell(1).value).toBe("Alice Coach");
      expect(r3.getCell(3).value).toBe("2026-05-09");
      expect(r3.getCell(6).value).toBe(2);

      const r4 = sheet.getRow(4);
      expect(r4.getCell(1).value).toBe("Bob Coach");
      expect(r4.getCell(2).value).toBe("Speed & Agility");
      expect(r4.getCell(6).value).toBe(1.5);

      expect(sheet.getColumn(6).numFmt).toBe("0.00");
    });

    it("renders the Schedule column from each row's scheduleNote", async () => {
      const buf = await buildHourLogWorkbook(makeRows(), {
        from: "2026-05-01",
        to: "2026-05-31",
      });
      const wb = await loadWorkbook(buf);
      const sheet = wb.getWorksheet("Detail")!;

      // Alice's rows have no schedule mismatch → empty Schedule cell.
      expect(sheet.getRow(2).getCell(8).value ?? "").toBe("");
      expect(sheet.getRow(3).getCell(8).value ?? "").toBe("");
      // Bob's row has a note.
      expect(sheet.getRow(4).getCell(8).value).toBe(
        "Alice Coach was scheduled.",
      );
    });
  });

  it("handles an empty row set cleanly (headers only, no data rows)", async () => {
    const buf = await buildHourLogWorkbook([], {
      from: "2026-05-01",
      to: "2026-05-31",
    });
    const wb = await loadWorkbook(buf);
    expect(wb.getWorksheet("Summary")!.rowCount).toBe(1);
    expect(wb.getWorksheet("Detail")!.rowCount).toBe(1);
  });
});
