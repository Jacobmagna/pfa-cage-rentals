// Builds the downloadable hour-log workbook. Two sheets, mirroring
// lib/reports/excel.ts (the billing report):
//   - Summary: one row per coach (coach, entry count, total hours).
//   - Detail:  one row per logged hour, grouped by coach then date.
//
// Hours discipline: each row's hours = (endAt − startAt) / 3,600,000,
// rounded to 2 decimal places. We sum the rounded per-row hours into
// the Summary total so the Summary always reconciles with the Detail
// sheet a coach can eyeball (no "off-by-a-rounding-cent" surprises).

import ExcelJS from "exceljs";
import { PFA_TIMEZONE, formatPfaDate } from "@/lib/timezone";

export type HourLogWorkbookRow = {
  id: string;
  coachId: string;
  coachName: string | null;
  coachEmail: string;
  programId: string;
  programName: string;
  startAt: Date;
  endAt: Date;
  note: string | null;
  // FEAT-16 schedule reconciliation note — null when the log matches the
  // schedule (or was unscheduled). Filled by
  // fetchHourLogRowsWithScheduleNotes; null on the base fetch.
  scheduleNote: string | null;
  // QA10 W3-polish13a: admin-only review fields. All three are optional on
  // the base workbook type — the Excel builder ignores them and the test
  // fixtures predate them. Only fetchHourLogRowsWithScheduleNotes fills
  // `unscheduled`; both fetches surface `reviewedAt`/`reviewedBy`. The
  // admin table (HourRow) re-declares them as required.
  // true when NO scheduled block the log's coach is a MEMBER of overlaps
  // it (same program) — the admin "Unscheduled" flag.
  unscheduled?: boolean;
  // Admin "Resolve" marker (see schema). Null = unreviewed.
  reviewedAt?: Date | null;
  reviewedBy?: string | null;
};

export type HourLogWorkbookMeta = {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
};

// Hours between two instants, rounded to 2dp. 3,600,000 ms per hour.
function hoursBetween(startAt: Date, endAt: Date): number {
  const raw = (endAt.getTime() - startAt.getTime()) / 3_600_000;
  return Math.round(raw * 100) / 100;
}

function coachLabel(row: HourLogWorkbookRow): string {
  return row.coachName ?? row.coachEmail;
}

// Stable PFA-local time "9:00 AM" for the Detail sheet — same wall clock
// for every viewer regardless of their browser TZ.
function formatTime12(d: Date): string {
  return d.toLocaleTimeString("en-US", {
    timeZone: PFA_TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
  });
}

export async function buildHourLogWorkbook(
  rows: HourLogWorkbookRow[],
  meta: HourLogWorkbookMeta,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "PFA Engine";
  workbook.created = new Date();
  workbook.subject = `Hours ${meta.from} to ${meta.to}`;

  // Sort by coach (label) then chronologically — groups every coach's
  // entries together on the Detail sheet and drives the Summary order.
  const sorted = [...rows].sort((a, b) => {
    const ca = coachLabel(a);
    const cb = coachLabel(b);
    if (ca !== cb) return ca.localeCompare(cb);
    return a.startAt.getTime() - b.startAt.getTime();
  });

  addSummarySheet(workbook, sorted);
  addDetailSheet(workbook, sorted);

  // exceljs writeBuffer returns ArrayBuffer / Uint8Array; coerce to a
  // Node Buffer so Next.js's Response constructor doesn't get cute with
  // the encoding.
  const out = await workbook.xlsx.writeBuffer();
  return Buffer.from(out);
}

function addSummarySheet(
  workbook: ExcelJS.Workbook,
  rows: HourLogWorkbookRow[],
) {
  const sheet = workbook.addWorksheet("Summary");

  sheet.columns = [
    { header: "Coach", key: "coach", width: 28 },
    { header: "Entries", key: "entries", width: 10 },
    { header: "Total Work Hours", key: "totalHours", width: 18 },
  ];

  // One row per coach, preserving the sorted order. Aggregate the
  // already-2dp per-row hours so Summary reconciles with Detail.
  const byCoach = new Map<
    string,
    { coach: string; entries: number; totalHours: number }
  >();
  for (const row of rows) {
    const label = coachLabel(row);
    const acc = byCoach.get(row.coachId) ?? {
      coach: label,
      entries: 0,
      totalHours: 0,
    };
    acc.entries += 1;
    acc.totalHours += hoursBetween(row.startAt, row.endAt);
    byCoach.set(row.coachId, acc);
  }

  for (const acc of byCoach.values()) {
    sheet.addRow({
      coach: acc.coach,
      entries: acc.entries,
      // Re-round the accumulated total to shed float drift.
      totalHours: Math.round(acc.totalHours * 100) / 100,
    });
  }

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.alignment = { vertical: "middle" };
  headerRow.border = { bottom: { style: "thin" } };

  const hoursCol = sheet.getColumn("totalHours");
  hoursCol.numFmt = "0.00";
  hoursCol.alignment = { horizontal: "right" };
  sheet.getColumn("entries").alignment = { horizontal: "right" };

  // Freeze the header row so it stays put while scrolling. Meta (the
  // date range) lives on the workbook itself via `subject`.
  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

function addDetailSheet(
  workbook: ExcelJS.Workbook,
  rows: HourLogWorkbookRow[],
) {
  const sheet = workbook.addWorksheet("Detail");

  sheet.columns = [
    { header: "Coach", key: "coach", width: 24 },
    { header: "Work", key: "program", width: 24 },
    { header: "Date", key: "date", width: 12 },
    { header: "Start", key: "start", width: 10 },
    { header: "End", key: "end", width: 10 },
    { header: "Work Hours", key: "hours", width: 12 },
    { header: "Note", key: "note", width: 40 },
    { header: "Schedule", key: "scheduleNote", width: 32 },
  ];

  // rows arrive pre-sorted by coach then date — grouped by coach.
  for (const row of rows) {
    sheet.addRow({
      coach: coachLabel(row),
      program: row.programName,
      date: formatPfaDate(row.startAt),
      start: formatTime12(row.startAt),
      end: formatTime12(row.endAt),
      hours: hoursBetween(row.startAt, row.endAt),
      note: row.note ?? "",
      scheduleNote: row.scheduleNote ?? "",
    });
  }

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.border = { bottom: { style: "thin" } };

  const hoursCol = sheet.getColumn("hours");
  hoursCol.numFmt = "0.00";
  hoursCol.alignment = { horizontal: "right" };

  sheet.views = [{ state: "frozen", ySplit: 1 }];
}
