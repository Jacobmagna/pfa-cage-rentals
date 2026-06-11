// Builds the downloadable attendance workbook for a single program +
// month (QA2 #14). Two sheets, mirroring lib/reports/hour-log-excel.ts:
//   - Summary: one row per athlete (athlete, sessions held, present,
//     absent, present %).
//   - Detail:  one row per athlete with a P / A / (blank) cell per
//     session date in the month — the same matrix the on-screen grid
//     shows, exported wide.
//
// Input is the pure buildAttendanceGrid output (athletes, sessions,
// present[athleteId][sessionId]) already scoped to the selected month by
// the route's set-based reads — so the workbook matches the browser grid
// exactly. No DB, no React here.

import ExcelJS from "exceljs";
import {
  formatGridDateWithWeekday,
  type AttendanceGrid,
} from "@/lib/server/attendance-grid";

export type AttendanceWorkbookMeta = {
  programName: string;
  /** "June 2026" — month label for the workbook subject. */
  monthLabel: string;
};

function athleteLabel(a: { firstName: string; lastName: string }): string {
  return `${a.lastName}, ${a.firstName}`;
}

export async function buildAttendanceWorkbook(
  grid: AttendanceGrid,
  meta: AttendanceWorkbookMeta,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "PFA Engine";
  workbook.created = new Date();
  workbook.subject = `Attendance — ${meta.programName} — ${meta.monthLabel}`;

  addSummarySheet(workbook, grid);
  addDetailSheet(workbook, grid);

  const out = await workbook.xlsx.writeBuffer();
  return Buffer.from(out);
}

function addSummarySheet(workbook: ExcelJS.Workbook, grid: AttendanceGrid) {
  const sheet = workbook.addWorksheet("Summary");

  sheet.columns = [
    { header: "Athlete", key: "athlete", width: 28 },
    { header: "Sessions Recorded", key: "recorded", width: 18 },
    { header: "Present", key: "present", width: 10 },
    { header: "Absent", key: "absent", width: 10 },
    { header: "Present %", key: "pct", width: 12 },
  ];

  for (const a of grid.athletes) {
    const marks = grid.present[a.id] ?? {};
    let present = 0;
    let absent = 0;
    for (const s of grid.sessions) {
      const m = marks[s.id];
      if (m === true) present += 1;
      else if (m === false) absent += 1;
      // undefined → no record taken, not counted in recorded total.
    }
    const recorded = present + absent;
    sheet.addRow({
      athlete: athleteLabel(a),
      recorded,
      present,
      absent,
      // Fraction so the "0%" numFmt renders it as a percentage. Blank
      // when no sessions were recorded (avoids a misleading 0%).
      pct: recorded > 0 ? present / recorded : null,
    });
  }

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.alignment = { vertical: "middle" };
  headerRow.border = { bottom: { style: "thin" } };

  for (const key of ["recorded", "present", "absent"]) {
    sheet.getColumn(key).alignment = { horizontal: "right" };
  }
  const pctCol = sheet.getColumn("pct");
  pctCol.numFmt = "0%";
  pctCol.alignment = { horizontal: "right" };

  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

function addDetailSheet(workbook: ExcelJS.Workbook, grid: AttendanceGrid) {
  const sheet = workbook.addWorksheet("Detail");

  // First column = athlete; one column per session date in the month.
  const columns: Partial<ExcelJS.Column>[] = [
    { header: "Athlete", key: "athlete", width: 24 },
  ];
  for (const s of grid.sessions) {
    columns.push({
      header: formatGridDateWithWeekday(s.sessionDate),
      key: `s_${s.id}`,
      width: 12,
    });
  }
  sheet.columns = columns;

  for (const a of grid.athletes) {
    const marks = grid.present[a.id] ?? {};
    const row: Record<string, string> = { athlete: athleteLabel(a) };
    for (const s of grid.sessions) {
      const m = marks[s.id];
      row[`s_${s.id}`] = m === true ? "P" : m === false ? "A" : "";
    }
    sheet.addRow(row);
  }

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.border = { bottom: { style: "thin" } };

  // Center the per-date P/A cells (every column past the athlete name).
  for (let i = 2; i <= grid.sessions.length + 1; i++) {
    sheet.getColumn(i).alignment = { horizontal: "center" };
  }

  // Freeze the header row AND the athlete-name column so the matrix
  // stays readable while scrolling a wide month.
  sheet.views = [{ state: "frozen", xSplit: 1, ySplit: 1 }];
}
