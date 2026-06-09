import { describe, it, expect } from "vitest";
import {
  LATE_LOG_HOURS,
  OVER_LOG_MARGIN_MINUTES,
  isLateLog,
  overLoggedMinutes,
  isOverLogged,
  buildScorecard,
  type CoachSignalCounts,
} from "./accountability";

const END = new Date("2026-06-01T12:00:00Z");

// Helper: an instant `mins` minutes after END.
function afterEnd(mins: number): Date {
  return new Date(END.getTime() + mins * 60000);
}

describe("constants", () => {
  it("locked thresholds", () => {
    expect(LATE_LOG_HOURS).toBe(24);
    expect(OVER_LOG_MARGIN_MINUTES).toBe(30);
  });
});

describe("isLateLog boundaries", () => {
  it("23h59m after end is NOT late", () => {
    expect(isLateLog(afterEnd(23 * 60 + 59), END)).toBe(false);
  });
  it("exactly 24h after end is NOT late (must be strictly over)", () => {
    expect(isLateLog(afterEnd(24 * 60), END)).toBe(false);
  });
  it("24h01m after end IS late", () => {
    expect(isLateLog(afterEnd(24 * 60 + 1), END)).toBe(true);
  });
  it("created before end is not late", () => {
    expect(isLateLog(afterEnd(-30), END)).toBe(false);
  });
});

describe("overLoggedMinutes", () => {
  // Block runs 12:00–13:00 (60 min scheduled).
  const blockStart = new Date("2026-06-01T12:00:00Z");
  const blockEnd = new Date("2026-06-01T13:00:00Z");

  it("90 logged vs 60 scheduled → 30", () => {
    const logStart = new Date("2026-06-01T12:00:00Z");
    const logEnd = new Date("2026-06-01T13:30:00Z");
    expect(overLoggedMinutes(logStart, logEnd, blockStart, blockEnd)).toBe(30);
  });
  it("91 logged vs 60 scheduled → 31", () => {
    const logStart = new Date("2026-06-01T12:00:00Z");
    const logEnd = new Date("2026-06-01T13:31:00Z");
    expect(overLoggedMinutes(logStart, logEnd, blockStart, blockEnd)).toBe(31);
  });
  it("60 logged vs 90 scheduled → -30 (under)", () => {
    const longEnd = new Date("2026-06-01T13:30:00Z"); // 90-min block
    const logStart = new Date("2026-06-01T12:00:00Z");
    const logEnd = new Date("2026-06-01T13:00:00Z"); // 60-min log
    expect(overLoggedMinutes(logStart, logEnd, blockStart, longEnd)).toBe(-30);
  });
});

describe("isOverLogged", () => {
  const blockStart = new Date("2026-06-01T12:00:00Z");
  const blockEnd = new Date("2026-06-01T13:00:00Z"); // 60-min

  it("90 vs 60 → 30 → NOT over (must be > 30)", () => {
    const logEnd = new Date("2026-06-01T13:30:00Z");
    expect(isOverLogged(blockStart, logEnd, blockStart, blockEnd)).toBe(false);
  });
  it("91 vs 60 → 31 → over", () => {
    const logEnd = new Date("2026-06-01T13:31:00Z");
    expect(isOverLogged(blockStart, logEnd, blockStart, blockEnd)).toBe(true);
  });
  it("negative (under) → not over", () => {
    const longEnd = new Date("2026-06-01T13:30:00Z"); // 90-min block
    const logEnd = new Date("2026-06-01T13:00:00Z"); // 60-min log
    expect(isOverLogged(blockStart, logEnd, blockStart, longEnd)).toBe(false);
  });
});

describe("buildScorecard", () => {
  const base = (
    over: Partial<CoachSignalCounts> & Pick<CoachSignalCounts, "coachId">,
  ): CoachSignalCounts => ({
    coachName: over.coachId,
    noShows: 0,
    lateCancels: 0,
    lateCancelRatePct: 0,
    repeatCanceller: false,
    lateLogs: 0,
    overLogged: 0,
    ...over,
  });

  it("computes totalConcerns as the sum of the four signals", () => {
    const [row] = buildScorecard([
      base({
        coachId: "c1",
        noShows: 1,
        lateCancels: 2,
        lateLogs: 3,
        overLogged: 4,
      }),
    ]);
    expect(row.totalConcerns).toBe(10);
  });

  it("sorts by totalConcerns desc, then coachName", () => {
    const out = buildScorecard([
      base({ coachId: "low", coachName: "Low", lateLogs: 1 }),
      base({ coachId: "high", coachName: "High", noShows: 5 }),
      base({ coachId: "mid", coachName: "Mid", overLogged: 3 }),
    ]);
    expect(out.map((r) => r.coachId)).toEqual(["high", "mid", "low"]);
  });

  it("ties broken alphabetically by coachName, nulls last", () => {
    const out = buildScorecard([
      base({ coachId: "z", coachName: "Zeta", noShows: 1 }),
      base({ coachId: "a", coachName: "Alpha", lateLogs: 1 }),
      base({ coachId: "n", coachName: null, overLogged: 1 }),
    ]);
    // all totalConcerns === 1, so alphabetical with null last.
    expect(out.map((r) => r.coachName)).toEqual(["Alpha", "Zeta", null]);
  });

  it("keeps coaches with zero concerns (totalConcerns 0)", () => {
    const out = buildScorecard([base({ coachId: "clean", coachName: "Clean" })]);
    expect(out).toHaveLength(1);
    expect(out[0].totalConcerns).toBe(0);
  });
});
