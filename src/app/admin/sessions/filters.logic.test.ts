import { describe, expect, it } from "vitest";
import { defaultSessionsRange, DEFAULT_RANGE_DAYS } from "./filters.logic";

// The Sessions tab defaults its From/To window to a band straddling
// today: today − 14 days through today + 14 days, in the FACILITY
// (America/New_York) timezone. These lock the pure date math so a
// refactor can't silently shift the default or regress to UTC.

describe("defaultSessionsRange", () => {
  it("returns today−14d → today+14d for a fixed mid-day instant", () => {
    // 2026-06-04 16:00Z is 12:00 EDT on 2026-06-04 (PFA today = Jun 4).
    const now = new Date("2026-06-04T16:00:00Z");
    const range = defaultSessionsRange(now);
    expect(range.from).toBe("2026-05-21"); // Jun 4 − 14 days
    expect(range.to).toBe("2026-06-18"); // Jun 4 + 14 days
  });

  it("uses PFA TZ for 'today', not UTC (late-night ET before UTC rollover)", () => {
    // 2026-06-05 02:30Z is still 2026-06-04 22:30 EDT — PFA today = Jun 4,
    // even though the UTC calendar day has already ticked to Jun 5.
    const now = new Date("2026-06-05T02:30:00Z");
    const range = defaultSessionsRange(now);
    expect(range.from).toBe("2026-05-21");
    expect(range.to).toBe("2026-06-18");
  });

  it("spans exactly 2 * DEFAULT_RANGE_DAYS days inclusive", () => {
    const now = new Date("2026-06-04T16:00:00Z");
    const { from, to } = defaultSessionsRange(now);
    const span =
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000;
    expect(span).toBe(2 * DEFAULT_RANGE_DAYS);
  });

  it("rolls over month/year boundaries correctly", () => {
    // 2026-01-08 12:00 EST → from crosses into prior year (Dec 2025),
    // to stays in Jan 2026.
    const now = new Date("2026-01-08T17:00:00Z");
    const range = defaultSessionsRange(now);
    expect(range.from).toBe("2025-12-25"); // Jan 8 − 14 days
    expect(range.to).toBe("2026-01-22"); // Jan 8 + 14 days
  });
});
