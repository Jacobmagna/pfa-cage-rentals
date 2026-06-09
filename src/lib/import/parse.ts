import ExcelJS from "exceljs";

export type RawSession = {
  date: string;
  resourceName: string;
  rawName: string;
  startTime: string;
  endTime: string;
  sourceTab: string;
};

const FIRST_SLOT_COL = 3;
const LAST_SLOT_COL = 30;
const RESOURCE_ROWS_PER_DAY = 10;

export async function parseWorkbook(input: ArrayBuffer | Buffer): Promise<RawSession[]> {
  const wb = new ExcelJS.Workbook();
  const buf = input instanceof ArrayBuffer ? Buffer.from(input) : input;
  // ExcelJS hijacks the global Buffer interface in its own .d.ts; cast matches src/lib/reports/excel.test.ts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await wb.xlsx.load(buf as any);

  const sessions: RawSession[] = [];
  for (const ws of wb.worksheets) {
    if (isTemplateTab(ws.name)) continue;
    sessions.push(...parseSheet(ws));
  }
  return sessions;
}

function isTemplateTab(name: string): boolean {
  return name.trim().toLowerCase().startsWith("template");
}

function parseSheet(ws: ExcelJS.Worksheet): RawSession[] {
  const out: RawSession[] = [];
  for (let r = 1; r <= ws.rowCount; r++) {
    const date = findDateInRow(ws, r);
    if (!date) continue;

    const dateStr = dateToYMD(date);
    const wrCounter = { n: 0 };

    for (let i = 0; i < RESOURCE_ROWS_PER_DAY; i++) {
      const resourceRowIdx = r + 2 + i;
      if (resourceRowIdx > ws.rowCount) break;
      const row = ws.getRow(resourceRowIdx);
      const label = cellText(row.getCell(1));
      if (label === "") continue;
      const { resourceName } = classifyResource(label, wrCounter, ws.name, resourceRowIdx);
      out.push(...emitRowRuns(row, dateStr, resourceName, ws.name));
    }
  }
  return out;
}

function emitRowRuns(
  row: ExcelJS.Row,
  date: string,
  resourceName: string,
  sourceTab: string,
): RawSession[] {
  const out: RawSession[] = [];
  let runStart: number | null = null;
  let runValue: string | null = null;

  const flush = (endColInclusive: number) => {
    if (runStart === null || runValue === null) return;
    out.push({
      date,
      resourceName,
      rawName: runValue,
      startTime: slotStart(runStart),
      endTime: slotStart(endColInclusive + 1),
      sourceTab,
    });
  };

  for (let c = FIRST_SLOT_COL; c <= LAST_SLOT_COL; c++) {
    const raw = cellText(row.getCell(c));
    if (raw === "") {
      if (runStart !== null) flush(c - 1);
      runStart = null;
      runValue = null;
      continue;
    }
    if (runValue === null) {
      runStart = c;
      runValue = raw;
    } else if (raw === runValue) {
      continue;
    } else {
      flush(c - 1);
      runStart = c;
      runValue = raw;
    }
  }
  if (runStart !== null) flush(LAST_SLOT_COL);
  return out;
}

function findDateInRow(ws: ExcelJS.Worksheet, r: number): Date | null {
  const row = ws.getRow(r);
  for (let c = 4; c <= LAST_SLOT_COL; c++) {
    const d = cellDate(row.getCell(c));
    if (d) return d;
  }
  return null;
}

function classifyResource(
  label: string,
  wrCounter: { n: number },
  tabName: string,
  rowIdx: number,
): { resourceName: string } {
  const trimmed = label.trim();
  // Cage labels carry a "(Hitting)" / "(Pitching)" parenthetical in the
  // source workbook; we still match it to extract the cage number, but
  // no longer derive a use type from it.
  const cage = trimmed.match(/^Cage\s+([1-5])\s*\(\s*(Hitting|Pitching)\s*\)$/i);
  if (cage) {
    return { resourceName: `Cage ${cage[1]}` };
  }
  const bullpen = trimmed.match(/^Bullpen\s+([12])$/i);
  if (bullpen) return { resourceName: `Bullpen ${bullpen[1]}` };

  if (/^Weight\s+Room$/i.test(trimmed)) {
    wrCounter.n += 1;
    if (wrCounter.n > 3) {
      throw new Error(`Parser error: more than 3 Weight Room rows in tab "${tabName}" at row ${rowIdx}`);
    }
    return { resourceName: `Weight Room ${wrCounter.n}` };
  }

  throw new Error(`Parser error: unknown resource label "${label}" in tab "${tabName}" at row ${rowIdx}`);
}

function slotStart(col: number): string {
  const minutesFrom8am = (col - FIRST_SLOT_COL) * 30;
  const hour = 8 + Math.floor(minutesFrom8am / 60);
  const minute = minutesFrom8am % 60;
  return `${pad2(hour)}:${pad2(minute)}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function dateToYMD(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function cellText(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v).trim();
  if (v instanceof Date) return "";
  if (typeof v === "object") {
    const obj = v as unknown as Record<string, unknown>;
    if (Array.isArray(obj.richText)) {
      return (obj.richText as Array<{ text?: string }>)
        .map((r) => r.text ?? "")
        .join("")
        .trim();
    }
    if ("text" in obj && obj.text != null) {
      const t = obj.text;
      if (typeof t === "string") return t.trim();
      if (typeof t === "object" && t !== null && Array.isArray((t as { richText?: unknown }).richText)) {
        return ((t as { richText: Array<{ text?: string }> }).richText)
          .map((r) => r.text ?? "")
          .join("")
          .trim();
      }
    }
    if ("result" in obj) {
      const r = obj.result;
      if (r == null) return "";
      if (r instanceof Date) return "";
      if (typeof r === "string") return r.trim();
      if (typeof r === "number") return String(r).trim();
    }
  }
  return "";
}

function cellDate(cell: ExcelJS.Cell): Date | null {
  const v = cell.value;
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === "object") {
    const obj = v as unknown as Record<string, unknown>;
    if ("result" in obj && obj.result instanceof Date) return obj.result;
  }
  return null;
}
