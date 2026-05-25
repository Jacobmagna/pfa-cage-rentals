// Builds the downloadable workbook from aggregated report data.
// Two sheets per BRAINSTORM.md:191-195 — Summary (one row per coach)
// + Detail (one row per session). Sheet 3 (Unmatched) is a
// historical-import concern, deferred to Stage I.
//
// Cents discipline:
//   - All money values arrive in cents from aggregateReport.
//   - We divide by 100 to write a JS number to the cell and apply
//     a currency numFmt so Excel renders "$X.XX".
//   - At the magnitudes we deal with (<= ~$10k per session), JS float
//     precision is safe. The integer-cents discipline upstream means
//     no .01-precision loss in totals.

import ExcelJS from "exceljs";
import type { ReportData } from "./aggregate";

export type WorkbookMeta = {
  from: string; // YYYY-MM-DD
  to: string;   // YYYY-MM-DD
};

const CURRENCY_FMT = '"$"#,##0.00';

export async function buildReportWorkbook(
  report: ReportData,
  meta: WorkbookMeta,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "PFA Cage Rentals";
  workbook.created = new Date();
  workbook.subject = `Billing ${meta.from} to ${meta.to}`;

  addSummarySheet(workbook, report);
  addDetailSheet(workbook, report);

  // exceljs writeBuffer returns ArrayBuffer / Uint8Array; coerce to
  // Node Buffer so Next.js's Response constructor doesn't get cute
  // with the encoding.
  const out = await workbook.xlsx.writeBuffer();
  return Buffer.from(out);
}

function addSummarySheet(workbook: ExcelJS.Workbook, report: ReportData) {
  const sheet = workbook.addWorksheet("Summary");

  sheet.columns = [
    { header: "Coach", key: "coach", width: 28 },
    { header: "Email", key: "email", width: 28 },
    { header: "Cage Slots", key: "cageSlots", width: 12 },
    { header: "Cage $", key: "cageDollars", width: 12 },
    { header: "Bullpen Slots", key: "bullpenSlots", width: 13 },
    { header: "Bullpen $", key: "bullpenDollars", width: 12 },
    { header: "WeightRoom Slots", key: "weightRoomSlots", width: 18 },
    { header: "WeightRoom $", key: "weightRoomDollars", width: 14 },
    { header: "Total", key: "total", width: 12 },
    { header: "Online Sessions", key: "onlineSessions", width: 16 },
  ];

  for (const row of report.summary) {
    sheet.addRow({
      coach: row.coachName,
      email: row.coachEmail,
      cageSlots: row.cageSlots,
      cageDollars: row.cageTotalCents / 100,
      bullpenSlots: row.bullpenSlots,
      bullpenDollars: row.bullpenTotalCents / 100,
      weightRoomSlots: row.weightRoomSlots,
      weightRoomDollars: row.weightRoomTotalCents / 100,
      total: row.totalCents / 100,
      onlineSessions: row.onlineSessions || "",
    });
  }

  // Grand total row at the bottom. Blank cells for non-applicable
  // columns; the "Total" cell holds the report's grand total.
  if (report.summary.length > 0) {
    const totalRow = sheet.addRow({
      coach: `Grand total (${report.detail.length} sessions)`,
      total: report.grandTotalCents / 100,
    });
    totalRow.font = { bold: true };
    totalRow.getCell("coach").alignment = { horizontal: "right" };
  }

  // Style the header row.
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.alignment = { vertical: "middle" };
  headerRow.border = { bottom: { style: "thin" } };

  // Currency formatting on the $ columns.
  for (const key of [
    "cageDollars",
    "bullpenDollars",
    "weightRoomDollars",
    "total",
  ] as const) {
    const col = sheet.getColumn(key);
    col.numFmt = CURRENCY_FMT;
    col.alignment = { horizontal: "right" };
  }

  // Right-align slot count columns.
  for (const key of ["cageSlots", "bullpenSlots", "weightRoomSlots"] as const) {
    sheet.getColumn(key).alignment = { horizontal: "right" };
  }

  // Freeze the header row so it stays put while Dad scrolls. Meta
  // (the date range) lives on the workbook itself via `subject`.
  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

function addDetailSheet(workbook: ExcelJS.Workbook, report: ReportData) {
  const sheet = workbook.addWorksheet("Detail");

  sheet.columns = [
    { header: "Date", key: "date", width: 12 },
    { header: "Day", key: "day", width: 6 },
    { header: "Start", key: "start", width: 8 },
    { header: "End", key: "end", width: 8 },
    { header: "Duration (min)", key: "duration", width: 14 },
    { header: "Resource", key: "resource", width: 14 },
    { header: "Use", key: "use", width: 10 },
    { header: "Coach", key: "coach", width: 24 },
    { header: "Team Rental", key: "teamRental", width: 12 },
    { header: "PFA-Referred", key: "pfaReferred", width: 14 },
    { header: "Online", key: "online", width: 8 },
    { header: "Slots", key: "slots", width: 8 },
    { header: "Rate", key: "rate", width: 10 },
    { header: "$", key: "total", width: 12 },
    { header: "Note", key: "note", width: 40 },
  ];

  for (const row of report.detail) {
    sheet.addRow({
      date: row.date,
      day: row.dayOfWeek,
      start: row.startTime,
      end: row.endTime,
      duration: row.durationMinutes,
      resource: row.resourceName,
      use: row.useType ?? "",
      coach: row.coachName,
      teamRental: row.isTeamRental ? "Yes" : "",
      pfaReferred: row.pfaReferred ? "Yes" : "",
      online: row.isOnline ? "Yes" : "",
      slots: row.slots,
      rate: row.ratePerSlotCents / 100,
      total: row.totalCents / 100,
      note: row.note ?? "",
    });
  }

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.border = { bottom: { style: "thin" } };

  for (const key of ["rate", "total"] as const) {
    const col = sheet.getColumn(key);
    col.numFmt = CURRENCY_FMT;
    col.alignment = { horizontal: "right" };
  }
  for (const key of ["slots", "duration"] as const) {
    sheet.getColumn(key).alignment = { horizontal: "right" };
  }

  sheet.views = [{ state: "frozen", ySplit: 1 }];
}
