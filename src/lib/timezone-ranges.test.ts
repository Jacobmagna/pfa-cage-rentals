import { describe, it, expect } from "vitest";
import { pfaWeekRange, pfaMonthRange, formatPfaDate } from "./timezone";

// PFA-local weekday short name ("Sun".."Sat") for a UTC instant.
function pfaWeekdayName(d: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  }).format(d);
}

describe("pfaWeekRange", () => {
  it("returns the Sunday→Sunday half-open range for a mid-week date", () => {
    // 2025-05-31 is a Saturday in ET.
    const { startUtc, endUtc } = pfaWeekRange("2025-05-31");
    expect(pfaWeekdayName(startUtc)).toBe("Sun");
    expect(formatPfaDate(startUtc)).toBe("2025-05-25");
    expect(pfaWeekdayName(endUtc)).toBe("Sun");
    expect(formatPfaDate(endUtc)).toBe("2025-06-01");
    expect(endUtc.getTime()).toBeGreaterThan(startUtc.getTime());
  });

  it("starts on the same Sunday when given a Sunday", () => {
    // 2025-05-25 is a Sunday in ET.
    const { startUtc } = pfaWeekRange("2025-05-25");
    expect(formatPfaDate(startUtc)).toBe("2025-05-25");
    expect(pfaWeekdayName(startUtc)).toBe("Sun");
  });

  it("week starts at PFA-local midnight (00:00 ET), not UTC midnight", () => {
    const { startUtc } = pfaWeekRange("2025-05-28");
    // Local midnight on 2025-05-25 (EDT, UTC-4) is 04:00 UTC.
    expect(startUtc.toISOString()).toBe("2025-05-25T04:00:00.000Z");
  });

  it("handles the spring DST boundary (week of 2025-03-09)", () => {
    // DST begins Sun 2025-03-09 in ET; that week is 1 hour short.
    const { startUtc, endUtc } = pfaWeekRange("2025-03-12");
    expect(formatPfaDate(startUtc)).toBe("2025-03-09");
    expect(formatPfaDate(endUtc)).toBe("2025-03-16");
    const hours = (endUtc.getTime() - startUtc.getTime()) / 3_600_000;
    expect(hours).toBe(7 * 24 - 1);
  });

  it("handles the fall DST boundary (week of 2025-11-02)", () => {
    // DST ends Sun 2025-11-02 in ET; that week is 1 hour long.
    const { startUtc, endUtc } = pfaWeekRange("2025-11-05");
    expect(formatPfaDate(startUtc)).toBe("2025-11-02");
    expect(formatPfaDate(endUtc)).toBe("2025-11-09");
    const hours = (endUtc.getTime() - startUtc.getTime()) / 3_600_000;
    expect(hours).toBe(7 * 24 + 1);
  });

  it("handles a week straddling the year boundary (Dec 2025 → Jan 2026)", () => {
    // 2025-12-31 is a Wednesday in ET; its week is Sun 12-28 → 2026-01-04.
    const { startUtc, endUtc } = pfaWeekRange("2025-12-31");
    expect(formatPfaDate(startUtc)).toBe("2025-12-28");
    expect(formatPfaDate(endUtc)).toBe("2026-01-04");
  });
});

describe("pfaMonthRange", () => {
  it("returns first-of-month → first-of-next-month, half-open", () => {
    const { startUtc, endUtc } = pfaMonthRange("2025-05-31");
    expect(formatPfaDate(startUtc)).toBe("2025-05-01");
    expect(formatPfaDate(endUtc)).toBe("2025-06-01");
    expect(endUtc.getTime()).toBeGreaterThan(startUtc.getTime());
  });

  it("rolls the year on December", () => {
    const { startUtc, endUtc } = pfaMonthRange("2025-12-15");
    expect(formatPfaDate(startUtc)).toBe("2025-12-01");
    expect(formatPfaDate(endUtc)).toBe("2026-01-01");
  });

  it("contains the spring DST transition within March", () => {
    const { startUtc, endUtc } = pfaMonthRange("2025-03-20");
    expect(formatPfaDate(startUtc)).toBe("2025-03-01");
    expect(formatPfaDate(endUtc)).toBe("2025-04-01");
  });

  it("starts at PFA-local midnight (00:00 ET) on the 1st", () => {
    const { startUtc } = pfaMonthRange("2025-07-04");
    // Local midnight on 2025-07-01 (EDT, UTC-4) is 04:00 UTC.
    expect(startUtc.toISOString()).toBe("2025-07-01T04:00:00.000Z");
  });
});
