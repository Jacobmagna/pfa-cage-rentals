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
  type HourLogWorkbookInputRow,
} from "./hour-log-excel";

// Two coaches, a few rows each, deliberately out of coach + date order
// so the builder's sort is exercised. Times are UTC instants; the
// hours math is TZ-independent (endAt − startAt).
function makeRows(): HourLogWorkbookInputRow[] {
  const d = (iso: string) => new Date(iso);
  // Every row here is POSTED, unreviewed and ON the schedule (0q fields), so
  // the Schedule column carries only the reconciliation note as before.
  const onSchedule = {
    status: "posted" as const,
    unscheduled: false,
    reviewedAt: null,
  };
  return [
    {
      ...onSchedule,
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
      ...onSchedule,
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
      ...onSchedule,
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
    expect(wb.creator).toBe("PFA Engine");
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
      expect(headers.slice(1)).toEqual([
        "Coach",
        "Entries",
        "Total Work Hours",
      ]);
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
        "Work",
        "Date",
        "Start",
        "End",
        "Work Hours",
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

/* ── 0q RELEASE 1 — "Not on schedule" in the hour-log workbook ───────────── */
//
// The Detail sheet's Schedule column (col 8) used to carry only the
// reconciliation note, which is null BOTH for a log that matched its block and
// for a log with no block at all — so a left-behind paid row read blank, like a
// perfect one (Sept 13 2026).
//
// Every left-behind POSTED row reads "Not on schedule"; a reviewed one adds its
// review date and nothing quieter (Jacob, 2026-10-14). This workbook also lists
// REJECTED rows: EVERY one of them now starts with "Rejected", because once
// some rejected rows say so, a blank would read as "not rejected".
//
// Read back with `includeEmpty: true` (rule 36); columns found by HEADER TEXT.

describe("🔴 0q — hour-log Detail Schedule column says 'Not on schedule'", () => {
  // 11:00 PDT on May 12.
  const STAMP = new Date("2026-05-12T18:00:00.000Z");
  let n = 0;
  function row(
    coachName: string,
    over: Partial<HourLogWorkbookInputRow>,
  ): HourLogWorkbookInputRow {
    n += 1;
    return {
      id: `r${n}`,
      coachId: coachName,
      coachName,
      coachEmail: `${coachName.replace(/\s/g, "").toLowerCase()}@x.com`,
      programId: "p1",
      programName: "BB - Fall Travelball - Game",
      startAt: new Date(`2026-05-0${n}T20:00:00Z`),
      endAt: new Date(`2026-05-0${n}T22:00:00Z`),
      note: null,
      scheduleNote: null,
      status: "posted",
      unscheduled: false,
      reviewedAt: null,
      ...over,
    };
  }

  function fixture(): HourLogWorkbookInputRow[] {
    n = 0;
    return [
      row("A Unreviewed", { unscheduled: true }),
      row("B Reviewed", { unscheduled: true, reviewedAt: STAMP }),
      row("C RejectedOff", { unscheduled: true, status: "rejected", reviewedAt: STAMP }),
      row("D Both", { unscheduled: true, scheduleNote: "Alice Coach was scheduled." }),
      row("E Clean", { reviewedAt: STAMP }),
      row("F CleanWithNote", { scheduleNote: "Scheduled 1:00 PM–2:00 PM" }),
      row("G RejectedOn", { status: "rejected", reviewedAt: STAMP }),
    ];
  }

  function rowValues(sheet: ExcelJS.Worksheet, r: number): unknown[] {
    const out: unknown[] = Array.from({ length: sheet.columnCount }, () => null);
    sheet.getRow(r).eachCell({ includeEmpty: true }, (cell, c) => {
      if (c <= out.length) out[c - 1] = cell.value;
    });
    return out;
  }

  async function scheduleByCoach(): Promise<Map<unknown, unknown>> {
    const buf = await buildHourLogWorkbook(fixture(), {
      from: "2026-05-01",
      to: "2026-05-31",
    });
    const sheet = (await loadWorkbook(buf)).getWorksheet("Detail")!;
    const headers = rowValues(sheet, 1);
    const coach = headers.indexOf("Coach");
    const schedule = headers.indexOf("Schedule");
    expect(coach, "Detail header not found: Coach").toBeGreaterThan(-1);
    // Still column 8 — the layout Mark knows.
    expect(schedule, "Detail header not found: Schedule").toBe(7);
    const out = new Map<unknown, unknown>();
    for (let r = 2; r <= sheet.rowCount; r++) {
      const v = rowValues(sheet, r);
      out.set(v[coach], v[schedule] ?? "");
    }
    expect(out.size).toBe(7);
    return out;
  }

  it("unreviewed posted row → 'Not on schedule'", async () => {
    expect((await scheduleByCoach()).get("A Unreviewed")).toBe("Not on schedule");
  });

  it("🔴 reviewed posted row → still 'Not on schedule', with the PFA review date", async () => {
    expect((await scheduleByCoach()).get("B Reviewed")).toBe(
      "Not on schedule (reviewed 2026-05-12)",
    );
  });

  it("🔴 a rejected row OFF the schedule → 'Rejected; Not on schedule' (no review date)", async () => {
    expect((await scheduleByCoach()).get("C RejectedOff")).toBe(
      "Rejected; Not on schedule",
    );
  });

  it("🔴 a rejected row ON the schedule → 'Rejected', never blank (control: a posted clean row IS blank)", async () => {
    const cells = await scheduleByCoach();
    expect(cells.get("G RejectedOn")).toBe("Rejected");
    expect(cells.get("E Clean")).toBe("");
  });

  it("label; note when both", async () => {
    expect((await scheduleByCoach()).get("D Both")).toBe(
      "Not on schedule; Alice Coach was scheduled.",
    );
  });

  it("clean posted rows keep today's cell — blank (even reviewed), or just the note (control: A is marked)", async () => {
    const cells = await scheduleByCoach();
    expect(cells.get("A Unreviewed")).toBe("Not on schedule");
    expect(cells.get("E Clean")).toBe("");
    expect(cells.get("F CleanWithNote")).toBe("Scheduled 1:00 PM–2:00 PM");
  });

  it("hours are unchanged by the flag (Summary sheet, same rows with and without it)", async () => {
    const read = async (rows: HourLogWorkbookInputRow[]) => {
      const sheet = (
        await loadWorkbook(
          await buildHourLogWorkbook(rows, { from: "2026-05-01", to: "2026-05-31" }),
        )
      ).getWorksheet("Summary")!;
      return Array.from({ length: sheet.rowCount }, (_, k) => rowValues(sheet, k + 1));
    };
    const flagged = await read(fixture());
    const clean = await read(fixture().map((r) => ({ ...r, unscheduled: false })));
    expect(flagged).toEqual(clean);
    // Control: the flag DID reach the flagged Detail sheet.
    expect((await scheduleByCoach()).get("A Unreviewed")).toBe("Not on schedule");
  });
});
