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
import { buildReportWorkbook, workRateCell, type ReportWorkbookInput } from "./excel";
import type { ReportData } from "./aggregate";
import type {
  PaymentTimelineData,
  PaymentTimelineEvent,
} from "./payments-timeline";
import type { WorkDetailRow, WorkReportData } from "./work-report";

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
        isGroupSession: false,
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
        isGroupSession: false,
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
        isGroupSession: false,
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
        groupWeightRoomSlots: 0,
        groupWeightRoomTotalCents: 0,
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
        groupWeightRoomSlots: 0,
        groupWeightRoomTotalCents: 0,
        programHours: 0,
        programTotalCents: 0,
        totalCents: 1400,
      },
    ],
    grandTotalCents: 5000,
    programGrandTotalCents: 0,
  };
}

// A work report whose numbers deliberately DIFFER from the cage side, so
// a sheet reading the wrong dataset shows up as a wrong number rather than
// an accidental match. Covers all three rate shapes the tab distinguishes:
// hourly, per-session, and never-rated.
function makeWork(): WorkReportData {
  const detail: WorkDetailRow[] = [
    {
      kind: "log" as const,
      stipendCovered: false,
      periodLabel: null,
      periodStart: null,
      periodEndExclusive: null,
      id: "w1",
      date: "2026-05-05",
      dayOfWeek: "Tue",
      startTime: "09:00",
      endTime: "11:00",
      hours: 2,
      programName: "HS Summer Program",
      coachId: "c1",
      coachName: "Alice Coach",
      coachEmail: "alice@x.com",
      ratePer30MinCents: 1500, // $30/hr
      perSessionRateCents: null,
      payCents: 6000,
      note: "bullpen work",
      scheduleNote: null,
    },
    {
      kind: "log" as const,
      stipendCovered: false,
      periodLabel: null,
      periodStart: null,
      periodEndExclusive: null,
      id: "w2",
      date: "2026-05-06",
      dayOfWeek: "Wed",
      startTime: "17:00",
      endTime: "20:12",
      hours: 3.2,
      programName: "HS Summer Travel - Game",
      coachId: "c1",
      coachName: "Alice Coach",
      coachEmail: "alice@x.com",
      ratePer30MinCents: null,
      perSessionRateCents: 10000, // flat $100 a game, whatever the duration
      payCents: 10000,
      note: null,
      scheduleNote: "Scheduled 5:00 PM–8:00 PM",
    },
    {
      kind: "log" as const,
      stipendCovered: false,
      periodLabel: null,
      periodStart: null,
      periodEndExclusive: null,
      id: "w3",
      date: "2026-05-07",
      dayOfWeek: "Thu",
      startTime: "08:00",
      endTime: "10:00",
      hours: 2,
      programName: "HS Summer Softball",
      coachId: "c2",
      coachName: "Bob Coach",
      coachEmail: "bob@x.com",
      ratePer30MinCents: null,
      perSessionRateCents: null, // never rated — pays $0
      payCents: 0,
      note: null,
      scheduleNote: null,
    },
  ];
  return {
    detail,
    summary: [
      {
        coachId: "c1",
        coachName: "Alice Coach",
        coachEmail: "alice@x.com",
        entries: 2,
        hours: 5.2,
        payCents: 16000,
      },
      {
        coachId: "c2",
        coachName: "Bob Coach",
        coachEmail: "bob@x.com",
        entries: 1,
        hours: 2,
        payCents: 0,
      },
    ],
    grandTotalCents: 16000,
    grandTotalHours: 7.2,
  };
}

const EMPTY_WORK: WorkReportData = {
  detail: [],
  summary: [],
  grandTotalCents: 0,
  grandTotalHours: 0,
};

const EMPTY_PAYMENTS: PaymentTimelineData = {
  events: [],
  totals: {
    recordedCoachToPfaCents: 0,
    recordedPfaToCoachCents: 0,
    recordedCount: 0,
    recordedSinceDeletedCount: 0,
  },
};

function makeEvent(
  over: Partial<PaymentTimelineEvent> & { id: string },
): PaymentTimelineEvent {
  return {
    paymentId: `p-${over.id}`,
    ts: new Date("2026-05-10T18:30:00Z"), // 11:30 AM Pacific
    kind: "recorded",
    actorLabel: "Mark Magna",
    coachLabel: "Alice Coach",
    amountCents: 180000,
    direction: "pfa_to_coach",
    changes: [],
    paymentDeleted: false,
    isLatestInRange: true,
    current: null,
    ...over,
  };
}

// The workbook is unconditionally complete — the scope booleans that
// used to drop columns are gone with the checkboxes that fed them
// (reports-tabs SPEC §5: a download is never narrowed by the UI).
const META = { from: "2026-05-01", to: "2026-05-31" } as const;
function build(
  report: ReportData,
  extra: Partial<Omit<ReportWorkbookInput, "report">> = {},
): Promise<Buffer> {
  return buildReportWorkbook(
    {
      report,
      work: extra.work ?? EMPTY_WORK,
      payments: extra.payments ?? EMPTY_PAYMENTS,
      paymentsTruncated: extra.paymentsTruncated ?? false,
    },
    META,
  );
}

/** Every non-empty cell in a column, as rendered — for scanning note rows. */
function columnText(sheet: ExcelJS.Worksheet, col: number): string[] {
  const out: string[] = [];
  sheet.eachRow((row) => {
    const v = row.getCell(col).value;
    if (typeof v === "string" && v.trim() !== "") out.push(v);
  });
  return out;
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
  it("produces a Buffer with all five sheets, in order", async () => {
    const buf = await build(makeReport());
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(2000);

    const wb = await loadWorkbook(buf);
    expect(wb.worksheets.map((s) => s.name)).toEqual([
      "Cage Summary",
      "Cage Detail",
      "Work Summary",
      "Work Detail",
      "Payments",
    ]);
  });

  // A workbook whose SHAPE depends on the data is a workbook nobody can
  // write a formula against. Every sheet exists even when its section is
  // empty — and an absent Payments sheet would read as "no payments
  // feature" rather than "no payments in this range".
  it("still writes all five sheets when work and payments are empty", async () => {
    const wb = await loadWorkbook(await build(makeReport()));
    expect(wb.worksheets).toHaveLength(5);
    expect(wb.getWorksheet("Work Detail")!.rowCount).toBeGreaterThanOrEqual(1);
    expect(columnText(wb.getWorksheet("Payments")!, 1)).toContain(
      "No payment activity in this date range.",
    );
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
      const sheet = wb.getWorksheet("Cage Summary")!;
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
        "Group WeightRoom Slots",
        "Group WeightRoom $",
        "Work Hours",
        "Work $",
        "Rental Owed $",
      ]);
    });

    it("renders dollar values divided by 100 with currency numFmt", async () => {
      const buf = await build(makeReport());
      const wb = await loadWorkbook(buf);
      const sheet = wb.getWorksheet("Cage Summary")!;
      const row2 = sheet.getRow(2);
      expect(row2.getCell(1).value).toBe("Alice Coach");
      expect(row2.getCell(4).value).toBe(36); // cage $ = 3600 cents / 100
      expect(row2.getCell(13).value).toBe(36); // Rental Owed $ (cage receivable, col 13)

      expect(sheet.getColumn(4).numFmt).toBe('"$"#,##0.00');
      expect(sheet.getColumn(13).numFmt).toBe('"$"#,##0.00');
    });

    it("appends a bold grand-total footer row", async () => {
      const buf = await build(makeReport());
      const wb = await loadWorkbook(buf);
      const sheet = wb.getWorksheet("Cage Summary")!;
      expect(sheet.rowCount).toBe(4); // 1 header + 2 coach rows + 1 footer
      const footer = sheet.getRow(4);
      expect(String(footer.getCell(1).value)).toContain("Grand total");
      expect(String(footer.getCell(1).value)).toContain("3 sessions");
      // Cage-side grand sits under "Rental Owed $" (col 13), NOT merged with
      // program pay. Work $ (col 12) holds the (here zero) program grand.
      expect(footer.getCell(13).value).toBe(50); // cage grand: 5000 cents / 100
      const programGrand = footer.getCell(12).value;
      expect(programGrand === 0 || programGrand === null || programGrand === "").toBe(true);
      expect(footer.font?.bold).toBe(true);
    });

    it("puts cage and program grand totals in SEPARATE columns, never summed", async () => {
      const report = makeReport();
      // Give a coach program pay so both grand totals are non-zero.
      report.summary[0].programHours = 2;
      report.summary[0].programTotalCents = 6000;
      report.programGrandTotalCents = 6000;
      const buf = await build(report);
      const wb = await loadWorkbook(buf);
      const sheet = wb.getWorksheet("Cage Summary")!;
      const footer = sheet.getRow(4);
      // Work $ grand under col 12, Rental Owed $ grand under col 13 — the
      // two opposite money directions are reported side by side, not added.
      expect(footer.getCell(12).value).toBe(60); // program pay grand: 6000 / 100
      expect(footer.getCell(13).value).toBe(50); // cage receivable grand: 5000 / 100
    });

    it("freezes the header row", async () => {
      const buf = await build(makeReport());
      const wb = await loadWorkbook(buf);
      const sheet = wb.getWorksheet("Cage Summary")!;
      const view = sheet.views?.[0];
      expect(view?.state).toBe("frozen");
      const ySplit = (view as { ySplit?: number } | undefined)?.ySplit;
      expect(ySplit).toBe(1);
    });

    // The two "drops the … columns when scope is off" tests that used to
    // live here are gone with the scope checkboxes. Their replacement is
    // the inverse guarantee: the column set is FIXED and always complete,
    // so no UI state can silently omit a category from a download
    // (reports-tabs SPEC §5 — work hours had never been exported at all).
    it("always writes the full column set, cage AND work together", async () => {
      const buf = await build(makeReport());
      const wb = await loadWorkbook(buf);
      const sheet = wb.getWorksheet("Cage Summary")!;
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
        "Group WeightRoom Slots",
        "Group WeightRoom $",
        "Work Hours",
        "Work $",
        "Rental Owed $",
      ]);
    });

    it("writes Work Hours/$ and applies currency format to Work $", async () => {
      const report = makeReport();
      report.summary[0].programHours = 1.5;
      report.summary[0].programTotalCents = 7500;
      const buf = await build(report);
      const wb = await loadWorkbook(buf);
      const sheet = wb.getWorksheet("Cage Summary")!;
      // Columns 11 Work Hours, 12 Work $ (see the full header set above).
      const row2 = sheet.getRow(2);
      expect(row2.getCell(11).value).toBe(1.5); // exact program hours
      expect(row2.getCell(12).value).toBe(75); // 7500 cents / 100
      expect(sheet.getColumn(12).numFmt).toBe('"$"#,##0.00');
    });
  });

  describe("Detail sheet", () => {
    it("has one row per session plus the header", async () => {
      const buf = await build(makeReport());
      const wb = await loadWorkbook(buf);
      const sheet = wb.getWorksheet("Cage Detail")!;
      expect(sheet.rowCount).toBe(4); // header + 3 sessions
    });

    // Detail column layout (1-based) after adding the "Rate basis" column:
    //   1 Date · 2 Day · 3 Start · 4 End · 5 Duration · 6 Resource
    //   7 Coach · 8 Slots · 9 Rate · 10 Rate basis · 11 $ · 12 Note
    it("writes dollar amounts per session", async () => {
      const buf = await build(makeReport());
      const wb = await loadWorkbook(buf);
      const sheet = wb.getWorksheet("Cage Detail")!;

      const row2 = sheet.getRow(2);
      expect(row2.getCell(1).value).toBe("2026-05-05");
      expect(row2.getCell(6).value).toBe("Cage 1");
      expect(row2.getCell(7).value).toBe("Alice Coach");
      expect(row2.getCell(8).value).toBe(2); // slots
      expect(row2.getCell(9).value).toBe(18); // cage: 1800 / 100, per 30 min
      expect(row2.getCell(10).value).toBe("per 30 min"); // cage rate basis
      expect(row2.getCell(11).value).toBe(36); // $ total
      expect(row2.getCell(12).value).toBe("warm-up");

      const row4 = sheet.getRow(4); // s3 — zero-rate session
      expect(row4.getCell(9).value).toBe(0); // rate 0
      expect(row4.getCell(11).value).toBe(0); // total 0
    });

    // Weight-room rate displays PER HOUR (×2) with a "per hr" basis, while
    // the $ TOTAL stays unchanged (snapshot/sums untouched).
    it("displays weight-room rate per hour with a per-hr basis", async () => {
      const buf = await build(makeReport());
      const wb = await loadWorkbook(buf);
      const sheet = wb.getWorksheet("Cage Detail")!;

      const row3 = sheet.getRow(3); // s2 — Weight Room 1, 700 cents/30min
      expect(row3.getCell(6).value).toBe("Weight Room 1");
      expect(row3.getCell(9).value).toBe(14); // 700 * 2 / 100 = per-hour rate
      expect(row3.getCell(10).value).toBe("per hr"); // weight-room basis
      expect(row3.getCell(11).value).toBe(14); // $ total unchanged (1400 / 100)
    });

    it("has the expected detail headers including Rate basis", async () => {
      const buf = await build(makeReport());
      const wb = await loadWorkbook(buf);
      const sheet = wb.getWorksheet("Cage Detail")!;
      const headers = (sheet.getRow(1).values as unknown[]).slice(1);
      expect(headers).toEqual([
        "Date",
        "Day",
        "Start",
        "End",
        "Duration (min)",
        "Resource",
        "Coach",
        "Slots",
        "Rate",
        "Rate basis",
        "$",
        "Note",
      ]);
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
    const summary = wb.getWorksheet("Cage Summary")!;
    expect(summary.rowCount).toBe(1);
    const detail = wb.getWorksheet("Cage Detail")!;
    expect(detail.rowCount).toBe(1);
  });

  // ── Work Summary ──────────────────────────────────────────────────────
  describe("Work Summary sheet", () => {
    it("has the expected header columns in order", async () => {
      const wb = await loadWorkbook(
        await build(makeReport(), { work: makeWork() }),
      );
      const headers = (
        wb.getWorksheet("Work Summary")!.getRow(1).values as unknown[]
      ).slice(1);
      expect(headers).toEqual([
        "Coach",
        "Email",
        "Entries",
        "Hours",
        "Work Pay $",
      ]);
    });

    it("writes one row per coach with cents divided by 100", async () => {
      const wb = await loadWorkbook(
        await build(makeReport(), { work: makeWork() }),
      );
      const sheet = wb.getWorksheet("Work Summary")!;

      const alice = sheet.getRow(2);
      expect(alice.getCell(1).value).toBe("Alice Coach");
      expect(alice.getCell(3).value).toBe(2); // entries
      expect(alice.getCell(4).value).toBe(5.2); // hours
      expect(alice.getCell(5).value).toBe(160); // 16000 cents

      // A coach whose logs were never rated pays $0 — a real zero, and it
      // must be written as one rather than left blank.
      const bob = sheet.getRow(3);
      expect(bob.getCell(1).value).toBe("Bob Coach");
      expect(bob.getCell(5).value).toBe(0);

      expect(sheet.getColumn(5).numFmt).toBe('"$"#,##0.00');
    });

    // SPEC §7. A bold number at the bottom of a payroll sheet with no
    // direction on it is the figure that gets read backwards.
    it("labels the grand total with the money DIRECTION", async () => {
      const wb = await loadWorkbook(
        await build(makeReport(), { work: makeWork() }),
      );
      const sheet = wb.getWorksheet("Work Summary")!;
      const total = sheet.getRow(4);
      expect(total.getCell(1).value).toBe("Grand total (3 entries)");
      // The direction lives in its OWN cell. A right-aligned label longer
      // than its column clips on the left in Excel, and this is the half
      // that would have been cut — leaving a bare bold payroll figure with
      // no direction on it.
      expect(total.getCell(2).value).toBe("PFA owes coaches");
      expect(total.getCell(4).value).toBe(7.2);
      expect(total.getCell(5).value).toBe(160);
      expect(total.font?.bold).toBe(true);
    });

    // 🔴 The single most valuable sentence on this sheet. Without it a
    // reader lands on a big number and reads it as "what I still owe" —
    // the app has no payout ledger, so it is nothing of the kind.
    it("carries the no-payout-ledger caveat and the posted-only note", async () => {
      const wb = await loadWorkbook(
        await build(makeReport(), { work: makeWork() }),
      );
      const notes = columnText(wb.getWorksheet("Work Summary")!, 1).join(" ");
      expect(notes).toContain("not what is still owed");
      expect(notes).toContain("Posted work only");
    });

    it("omits the grand-total row when there is no work", async () => {
      const wb = await loadWorkbook(await build(makeReport()));
      const notes = columnText(wb.getWorksheet("Work Summary")!, 1);
      expect(notes.some((t) => t.startsWith("Grand total"))).toBe(false);
    });

    // The Cage Summary's per-coach "Work $" column and this sheet's grand
    // total are the SAME money from the SAME function (workPayForLog over
    // the same posted rows). A workbook that quotes two different work
    // totals is worse than one that quotes none.
    it("reconciles its grand total with the Cage Summary's Work $ column", async () => {
      const report = makeReport();
      const work = makeWork();
      // Mirror what the real pipeline produces: the aggregate's work total
      // is the same sum buildWorkReport arrives at.
      report.summary[0].programTotalCents = 16000;
      report.summary[1].programTotalCents = 0;
      report.programGrandTotalCents = 16000;

      const wb = await loadWorkbook(await build(report, { work }));
      const cage = wb.getWorksheet("Cage Summary")!;
      const cageWorkTotal = cage.getRow(4).getCell(12).value; // "Work $" on the total row
      const workTotal = wb
        .getWorksheet("Work Summary")!
        .getRow(4)
        .getCell(5).value;
      expect(cageWorkTotal).toBe(workTotal);
      expect(workTotal).toBe(160);
    });
  });

  // ── Work Detail ───────────────────────────────────────────────────────
  describe("Work Detail sheet", () => {
    it("has the expected header columns in order", async () => {
      const wb = await loadWorkbook(
        await build(makeReport(), { work: makeWork() }),
      );
      const headers = (
        wb.getWorksheet("Work Detail")!.getRow(1).values as unknown[]
      ).slice(1);
      expect(headers).toEqual([
        "Date",
        "Day",
        "Start",
        "End",
        "Hours",
        "Program",
        "Coach",
        "Rate",
        "Rate basis",
        "Pay $",
        "Note",
        "Schedule",
      ]);
    });

    it("writes an hourly log with the rate doubled to per-hour", async () => {
      const wb = await loadWorkbook(
        await build(makeReport(), { work: makeWork() }),
      );
      const row = wb.getWorksheet("Work Detail")!.getRow(2);
      expect(row.getCell(1).value).toBe("2026-05-05");
      expect(row.getCell(5).value).toBe(2); // hours
      expect(row.getCell(6).value).toBe("HS Summer Program");
      expect(row.getCell(8).value).toBe(30); // 1500¢/30min → $30/hr
      expect(row.getCell(9).value).toBe("per hr");
      expect(row.getCell(10).value).toBe(60); // pay
    });

    // The game-rate bug in one row: a flat fee must NOT be rendered as an
    // hourly figure, or the Rate column stops reproducing the Pay column.
    it("writes a per-session log as a flat fee, not an hourly rate", async () => {
      const wb = await loadWorkbook(
        await build(makeReport(), { work: makeWork() }),
      );
      const row = wb.getWorksheet("Work Detail")!.getRow(3);
      expect(row.getCell(5).value).toBe(3.2); // 3.2 hours...
      expect(row.getCell(8).value).toBe(100); // ...still $100
      expect(row.getCell(9).value).toBe("per session");
      expect(row.getCell(10).value).toBe(100);
    });

    // 🔴 A never-rated log must leave the Rate cell EMPTY. Writing 0 there
    // renders "$0.00", which reads as a deliberate zero rate rather than a
    // missing one — the same distinction the on-screen "No rate" cell makes.
    it("leaves the rate BLANK (not $0.00) when no rate was ever stamped", async () => {
      const wb = await loadWorkbook(
        await build(makeReport(), { work: makeWork() }),
      );
      const row = wb.getWorksheet("Work Detail")!.getRow(4);
      expect(row.getCell(8).value).toBeNull();
      expect(row.getCell(9).value).toBe("No rate");
      expect(row.getCell(10).value).toBe(0); // the PAY is a real zero
    });

    it("carries the note and schedule columns through", async () => {
      const wb = await loadWorkbook(
        await build(makeReport(), { work: makeWork() }),
      );
      const sheet = wb.getWorksheet("Work Detail")!;
      expect(sheet.getRow(2).getCell(11).value).toBe("bullpen work");
      expect(sheet.getRow(3).getCell(12).value).toBe(
        "Scheduled 5:00 PM–8:00 PM",
      );
    });
  });

  describe("workRateCell", () => {
    it("matches the on-screen RateCell for all three shapes", () => {
      expect(workRateCell(1500, null, { kind: "log", covered: false })).toEqual({
        dollars: 30,
        basis: "per hr",
      });
      expect(workRateCell(null, 10000, { kind: "log", covered: false })).toEqual({
        dollars: 100,
        basis: "per session",
      });
      expect(workRateCell(null, null, { kind: "log", covered: false })).toEqual({
        dollars: undefined,
        basis: "No rate",
      });
    });

    it("prefers the per-session snapshot when a log somehow carries both", () => {
      // workPayForLog branches on perSessionRateCents first, so the rate
      // shown has to branch the same way or the Rate column would stop
      // explaining the Pay column.
      expect(workRateCell(1500, 10000, { kind: "log", covered: false })).toEqual({
        dollars: 100,
        basis: "per session",
      });
    });
  });

  // ── Payments ──────────────────────────────────────────────────────────
  describe("Payments sheet", () => {
    const payments: PaymentTimelineData = {
      events: [
        makeEvent({ id: "e1" }),
        makeEvent({
          id: "e2",
          kind: "edited",
          amountCents: 175025,
          direction: "coach_to_pfa",
          changes: [
            { label: "Amount", from: "$1,800.00", to: "$1,750.25" },
          ],
        }),
        makeEvent({
          id: "e3",
          kind: "recorded",
          amountCents: 17000,
          direction: "coach_to_pfa",
          paymentDeleted: true,
        }),
        // No amount and no direction — a changed-keys-only diff whose
        // payment row no longer joins.
        makeEvent({
          id: "e4",
          kind: "confirmed",
          amountCents: null,
          direction: null,
        }),
      ],
      totals: {
        recordedCoachToPfaCents: 17000,
        recordedPfaToCoachCents: 180000,
        recordedCount: 2,
        recordedSinceDeletedCount: 1,
      },
    };

    it("has the expected header columns in order", async () => {
      const wb = await loadWorkbook(await build(makeReport(), { payments }));
      const headers = (
        wb.getWorksheet("Payments")!.getRow(1).values as unknown[]
      ).slice(1);
      expect(headers).toEqual([
        "Date",
        "Time",
        "Event",
        "Payment",
        "Coach",
        "Amount $",
        "Direction",
        "By",
        "What changed",
        "Payment status",
      ]);
    });

    // 🔴 Found by reading a real export, not by an assertion: two DIFFERENT
    // payments of the same amount, to the same coach, on the same day
    // render as byte-identical rows. On a money log the reader's question
    // is "was this recorded twice by mistake?" — the reference is what
    // lets them answer it.
    it("stamps each row with its payment reference", async () => {
      const wb = await loadWorkbook(await build(makeReport(), { payments }));
      const sheet = wb.getWorksheet("Payments")!;
      expect(sheet.getRow(2).getCell(4).value).toBe("#p-e1");
      expect(sheet.getRow(3).getCell(4).value).toBe("#p-e2");
      // Distinct payments must be distinguishable.
      expect(sheet.getRow(2).getCell(4).value).not.toBe(
        sheet.getRow(3).getCell(4).value,
      );
    });

    // ⚠️ audit_log.ts is `timestamp` WITHOUT tz. The stored instant is
    // 18:30 UTC, which is 11:30 AM in the facility's Pacific day — not
    // 6:30 PM, and not the next day. This repo has been bitten by that
    // twice; slicing an ISO string here would misdate every late-afternoon
    // payment, and only west of UTC, which is the entire customer.
    it("renders the event timestamp in the FACILITY timezone", async () => {
      const wb = await loadWorkbook(await build(makeReport(), { payments }));
      const row = wb.getWorksheet("Payments")!.getRow(2);
      expect(row.getCell(1).value).toBe("2026-05-10");
      expect(row.getCell(2).value).toBe("11:30 AM");
    });

    it("writes each event with its amount, direction and actor", async () => {
      const wb = await loadWorkbook(await build(makeReport(), { payments }));
      const row = wb.getWorksheet("Payments")!.getRow(2);
      expect(row.getCell(3).value).toBe("Recorded");
      expect(row.getCell(5).value).toBe("Alice Coach");
      expect(row.getCell(6).value).toBe(1800);
      expect(row.getCell(7).value).toBe("PFA paid coach");
      expect(row.getCell(8).value).toBe("Mark Magna");
    });

    it("spells out what changed on an edit", async () => {
      const wb = await loadWorkbook(await build(makeReport(), { payments }));
      expect(wb.getWorksheet("Payments")!.getRow(3).getCell(9).value).toBe(
        "Amount: $1,800.00 → $1,750.25",
      );
    });

    it("flags a recorded payment that has since been deleted", async () => {
      const wb = await loadWorkbook(await build(makeReport(), { payments }));
      expect(wb.getWorksheet("Payments")!.getRow(4).getCell(10).value).toBe(
        "Deleted",
      );
    });

    // 🔴 Never invent a figure. An event whose diff carries no amount and
    // whose payment row no longer joins renders BLANK — $0.00 would be a
    // number nobody wrote.
    it("leaves the amount BLANK when the event carries none", async () => {
      const wb = await loadWorkbook(await build(makeReport(), { payments }));
      const row = wb.getWorksheet("Payments")!.getRow(5);
      expect(row.getCell(6).value).toBeNull(); // amount — no cell at all
      expect(row.getCell(7).value).toBe(""); // direction — blank text
      // The event itself is still there. Dropping the row would hide that
      // something happened to the money; showing it with an invented $0.00
      // would be worse.
      expect(row.getCell(3).value).toBe("Confirmed");
    });

    // SPEC §7 — the two directions are reported side by side and NEVER
    // netted. $180,000 out and $170 in must not collapse into one number.
    it("writes the two direction totals separately, never netted", async () => {
      const wb = await loadWorkbook(await build(makeReport(), { payments }));
      const sheet = wb.getWorksheet("Payments")!;
      const labels = columnText(sheet, 1);
      expect(labels).toContain("Recorded in range — coach paid PFA");
      expect(labels).toContain("Recorded in range — PFA paid coach");

      const amounts: number[] = [];
      sheet.eachRow((row) => {
        const v = row.getCell(6).value;
        if (typeof v === "number") amounts.push(v);
      });
      expect(amounts).toContain(170); // coach → PFA
      expect(amounts).toContain(1800); // PFA → coach
      // A netted figure would be 1800 - 170 = 1630. It must not exist.
      expect(amounts).not.toContain(1630);
    });

    // SPEC §11 decision 4. An unlabelled difference between two money
    // surfaces reads as a bug in the money.
    it("labels the totals as RANGED activity, not balances", async () => {
      const wb = await loadWorkbook(await build(makeReport(), { payments }));
      const notes = columnText(wb.getWorksheet("Payments")!, 1).join(" ");
      expect(notes).toContain("Payments recorded in range: 2.");
      expect(notes).toContain("not balances");
      expect(notes).toContain(
        "will not match the Payments page's all-time figures",
      );
      expect(notes).toContain("has since been deleted");
      // A payment has no program or resource, so those filters cannot
      // narrow this sheet — say so, or an admin who exported with a
      // program filter set reads the other payments as missing.
      expect(notes).toContain(
        "The resource-type and program filters do not apply to payments",
      );
    });

    // 🔴 A silently shortened money history inside a file someone emails
    // on is worse than on screen — the caveat can't be re-read from the UI.
    it("says so, loudly, when the timeline was truncated", async () => {
      const wb = await loadWorkbook(
        await build(makeReport(), { payments, paymentsTruncated: true }),
      );
      const notes = columnText(wb.getWorksheet("Payments")!, 1).join(" ");
      expect(notes).toContain("TRUNCATED");
      expect(notes).toContain("most recent entries ONLY");
    });

    it("stays silent about truncation when nothing was truncated", async () => {
      const wb = await loadWorkbook(await build(makeReport(), { payments }));
      const notes = columnText(wb.getWorksheet("Payments")!, 1).join(" ");
      expect(notes).not.toContain("TRUNCATED");
    });
  });
});
