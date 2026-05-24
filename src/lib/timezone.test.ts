import { describe, expect, it } from "vitest";
import { formatPfaDate, formatPfaTime, pfaWallClockToUtc } from "./timezone";

describe("pfaWallClockToUtc", () => {
  it("converts an EDT wall-clock to UTC (May = UTC-4)", () => {
    const d = pfaWallClockToUtc("2026-05-01", "14:30");
    expect(d.toISOString()).toBe("2026-05-01T18:30:00.000Z");
  });

  it("converts an EST wall-clock to UTC (January = UTC-5)", () => {
    const d = pfaWallClockToUtc("2026-01-15", "09:00");
    expect(d.toISOString()).toBe("2026-01-15T14:00:00.000Z");
  });

  it("round-trips through formatPfaDate + formatPfaTime", () => {
    for (const [date, time] of [
      ["2026-05-01", "08:00"],
      ["2026-05-01", "21:30"],
      ["2026-01-15", "12:00"],
      ["2026-11-30", "17:45"],
    ] as const) {
      const utc = pfaWallClockToUtc(date, time);
      expect(formatPfaDate(utc)).toBe(date);
      expect(formatPfaTime(utc)).toBe(time);
    }
  });

  it("throws on invalid inputs", () => {
    expect(() => pfaWallClockToUtc("not-a-date", "14:30")).toThrow();
  });
});
