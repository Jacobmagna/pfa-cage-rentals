import { readFile } from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { parseWorkbook, type RawSession } from "./parse";

const FIXTURE = path.resolve(__dirname, "../../../source_data.xlsx");

async function loadFixture(): Promise<RawSession[]> {
  return parseWorkbook(await readFile(FIXTURE));
}

describe("parseWorkbook (real source_data.xlsx)", () => {
  it("emits a stable total count of historical sessions", async () => {
    const sessions = await loadFixture();
    expect(sessions).toHaveLength(347);
  });

  it("skips the leading-space Template tab", async () => {
    const sessions = await loadFixture();
    const tabs = new Set(sessions.map((s) => s.sourceTab));
    expect(tabs.has(" Template 250706")).toBe(false);
    expect(tabs.has("Template 250706")).toBe(false);
  });

  it("collapses D. Lusk's 14-cell run in Cage 1 on May 1 into one session", async () => {
    const sessions = await loadFixture();
    const lusk = sessions.filter(
      (s) => s.date === "2026-05-01" && s.resourceName === "Cage 1" && s.rawName === "D. Lusk",
    );
    expect(lusk).toHaveLength(1);
    expect(lusk[0]).toEqual({
      date: "2026-05-01",
      resourceName: "Cage 1",
      useTypeHint: "pitching",
      rawName: "D. Lusk",
      startTime: "14:30",
      endTime: "21:30",
      sourceTab: "May 1-3",
    });
  });

  it("does NOT normalize raw names — Shannon and 'Shannon v' stay separate", async () => {
    const sessions = await loadFixture();
    const cage5May1 = sessions.filter((s) => s.date === "2026-05-01" && s.resourceName === "Cage 5");
    const rawNames = cage5May1.map((s) => s.rawName).sort();
    expect(rawNames).toEqual(["Shannon", "Shannon v"]);
  });

  it("assigns useTypeHint from the row label (cages get pitching/hitting; others null)", async () => {
    const sessions = await loadFixture();
    const seen = new Map<string, Set<string>>();
    for (const s of sessions) {
      const key = `${s.useTypeHint}`;
      if (!seen.has(s.resourceName)) seen.set(s.resourceName, new Set());
      seen.get(s.resourceName)!.add(key);
    }
    expect(Array.from(seen.get("Cage 1") ?? [])).toEqual(["pitching"]);
    expect(Array.from(seen.get("Cage 2") ?? [])).toEqual(["pitching"]);
    expect(Array.from(seen.get("Cage 3") ?? [])).toEqual(["pitching"]);
    expect(Array.from(seen.get("Cage 4") ?? [])).toEqual(["hitting"]);
    expect(Array.from(seen.get("Cage 5") ?? [])).toEqual(["hitting"]);
    expect(Array.from(seen.get("Bullpen 1") ?? [])).toEqual(["null"]);
    expect(Array.from(seen.get("Bullpen 2") ?? [])).toEqual(["null"]);
    expect(Array.from(seen.get("Weight Room 1") ?? [])).toEqual(["null"]);
  });

  it("disambiguates the three Weight Room rows by position", async () => {
    const sessions = await loadFixture();
    const wrNames = new Set(sessions.filter((s) => s.resourceName.startsWith("Weight Room")).map((s) => s.resourceName));
    for (const name of wrNames) {
      expect(["Weight Room 1", "Weight Room 2", "Weight Room 3"]).toContain(name);
    }
  });

  it("emits exclusive endTimes (end = start of the slot after the last filled cell)", async () => {
    const sessions = await loadFixture();
    for (const s of sessions) {
      expect(s.startTime < s.endTime).toBe(true);
      const [eh, em] = s.endTime.split(":").map(Number);
      const endMin = eh * 60 + em;
      expect(endMin).toBeGreaterThanOrEqual(8 * 60 + 30);
      expect(endMin).toBeLessThanOrEqual(22 * 60);
    }
  });
});

describe("parseWorkbook (synthetic edge cases)", () => {
  it("throws on an unknown resource label", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Test Week");
    ws.getRow(4).getCell(4).value = new Date(Date.UTC(2026, 0, 1));
    ws.getRow(5).getCell(3).value = "8:00-8:30";
    ws.getRow(6).getCell(1).value = "Cage 99 (Pitching)";

    const buf = await wb.xlsx.writeBuffer();
    await expect(parseWorkbook(buf as ArrayBuffer)).rejects.toThrow(/unknown resource label.*Cage 99/i);
  });

  it("throws when a tab has more than 3 Weight Room rows", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Test Week");
    ws.getRow(4).getCell(4).value = new Date(Date.UTC(2026, 0, 1));
    ws.getRow(5).getCell(3).value = "8:00-8:30";
    // 10 resource rows, with 4 of them Weight Room (within the 10-row window)
    ws.getRow(6).getCell(1).value = "Cage 1 (Pitching)";
    ws.getRow(7).getCell(1).value = "Cage 2 (Pitching)";
    ws.getRow(8).getCell(1).value = "Cage 3 (Pitching)";
    ws.getRow(9).getCell(1).value = "Cage 4 (Hitting)";
    ws.getRow(10).getCell(1).value = "Cage 5 (Hitting)";
    ws.getRow(11).getCell(1).value = "Bullpen 1";
    ws.getRow(12).getCell(1).value = "Weight Room";
    ws.getRow(13).getCell(1).value = "Weight Room";
    ws.getRow(14).getCell(1).value = "Weight Room";
    ws.getRow(15).getCell(1).value = "Weight Room"; // 4th WR — should trigger throw

    const buf = await wb.xlsx.writeBuffer();
    await expect(parseWorkbook(buf as ArrayBuffer)).rejects.toThrow(/more than 3 Weight Room/i);
  });

  it("processes a minimal valid day block and emits the expected session", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Minimal");
    ws.getRow(4).getCell(4).value = new Date(Date.UTC(2026, 4, 1));
    ws.getRow(5).getCell(3).value = "8:00-8:30";
    ws.getRow(6).getCell(1).value = "Cage 1 (Pitching)";
    // 3 consecutive cells with same name = one session
    ws.getRow(6).getCell(5).value = "Test Coach";
    ws.getRow(6).getCell(6).value = "Test Coach";
    ws.getRow(6).getCell(7).value = "Test Coach";

    const buf = await wb.xlsx.writeBuffer();
    const sessions = await parseWorkbook(buf as ArrayBuffer);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toEqual({
      date: "2026-05-01",
      resourceName: "Cage 1",
      useTypeHint: "pitching",
      rawName: "Test Coach",
      startTime: "09:00",
      endTime: "10:30",
      sourceTab: "Minimal",
    });
  });

  it("skips tabs whose name starts with 'template' (any case, with/without leading whitespace)", async () => {
    const wb = new ExcelJS.Workbook();
    for (const name of ["Template 1", " template 2", "TEMPLATE 3"]) {
      const ws = wb.addWorksheet(name);
      ws.getRow(4).getCell(4).value = new Date(Date.UTC(2026, 0, 1));
      ws.getRow(5).getCell(3).value = "8:00-8:30";
      ws.getRow(6).getCell(1).value = "Cage 1 (Pitching)";
      ws.getRow(6).getCell(3).value = "Should be ignored";
    }
    const buf = await wb.xlsx.writeBuffer();
    const sessions = await parseWorkbook(buf as ArrayBuffer);
    expect(sessions).toHaveLength(0);
  });
});
