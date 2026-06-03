import { describe, expect, it } from "vitest";
import {
  generateOccurrences,
  MAX_OCCURRENCES,
} from "@/lib/schedule-recurrence";
import { formatPfaDate, formatPfaTime } from "@/lib/timezone";

// 2026-01-04 is a Sunday (getUTCDay 0). Used as a stable anchor for the
// weekday assertions below.
describe("generateOccurrences", () => {
  it("expands a single weekday across N weeks", () => {
    // Mondays (1) for 4 weeks. 2026-01-05 is a Monday.
    const occ = generateOccurrences({
      daysOfWeek: [1],
      startTime: "09:00",
      endTime: "10:00",
      startsOn: "2026-01-05",
      endsOn: "2026-02-01",
    });
    expect(occ.map((o) => o.date)).toEqual([
      "2026-01-05",
      "2026-01-12",
      "2026-01-19",
      "2026-01-26",
    ]);
  });

  it("handles multiple weekdays (Mon+Wed) with correct count and dates", () => {
    // Mon (1) + Wed (3) for the week of 2026-01-05..2026-01-11.
    const occ = generateOccurrences({
      daysOfWeek: [1, 3],
      startTime: "16:00",
      endTime: "17:30",
      startsOn: "2026-01-05",
      endsOn: "2026-01-18",
    });
    expect(occ.map((o) => o.date)).toEqual([
      "2026-01-05", // Mon
      "2026-01-07", // Wed
      "2026-01-12", // Mon
      "2026-01-14", // Wed
    ]);
    expect(occ).toHaveLength(4);
  });

  it("excludes dates listed in skipDates", () => {
    const occ = generateOccurrences({
      daysOfWeek: [1],
      startTime: "09:00",
      endTime: "10:00",
      startsOn: "2026-01-05",
      endsOn: "2026-02-01",
      skipDates: ["2026-01-12", "2026-01-26"],
    });
    expect(occ.map((o) => o.date)).toEqual(["2026-01-05", "2026-01-19"]);
  });

  it("yields a single occurrence when start==end on a matching weekday", () => {
    const occ = generateOccurrences({
      daysOfWeek: [1],
      startTime: "09:00",
      endTime: "10:00",
      startsOn: "2026-01-05",
      endsOn: "2026-01-05",
    });
    expect(occ).toHaveLength(1);
    expect(occ[0].date).toBe("2026-01-05");
  });

  it("yields nothing when the single day is not a chosen weekday", () => {
    // 2026-01-06 is a Tuesday (2); we only want Mondays.
    const occ = generateOccurrences({
      daysOfWeek: [1],
      startTime: "09:00",
      endTime: "10:00",
      startsOn: "2026-01-06",
      endsOn: "2026-01-06",
    });
    expect(occ).toHaveLength(0);
  });

  it("produces DST-correct wall-clock times (EST in March, EDT in November)", () => {
    // A Wednesday before the spring-forward (2026-03-04, still EST) and a
    // Wednesday after fall-back (2026-11-04, EST again). The wall-clock
    // 09:00–10:00 PFA time must round-trip regardless of the UTC offset.
    const occ = generateOccurrences({
      daysOfWeek: [3],
      startTime: "09:00",
      endTime: "10:00",
      // 2026-03-11 is a Wed (EDT), 2026-11-04 is a Wed (EST). Range spans
      // both DST transitions.
      startsOn: "2026-03-11",
      endsOn: "2026-11-04",
    });
    // Every occurrence must read back as 09:00 PFA wall-clock on its date.
    for (const o of occ) {
      expect(formatPfaTime(o.startAt)).toBe("09:00");
      expect(formatPfaTime(o.endAt)).toBe("10:00");
      expect(formatPfaDate(o.startAt)).toBe(o.date);
    }
    // Sanity: the March (EDT) occurrence and the November (EST)
    // occurrence have different UTC hours despite identical wall-clock.
    const march = occ.find((o) => o.date === "2026-03-11");
    const november = occ.find((o) => o.date === "2026-11-04");
    expect(march).toBeDefined();
    expect(november).toBeDefined();
    // EDT is UTC-4 → 09:00 EDT = 13:00Z; EST is UTC-5 → 09:00 EST = 14:00Z.
    expect(march!.startAt.getUTCHours()).toBe(13);
    expect(november!.startAt.getUTCHours()).toBe(14);
  });

  it("throws on an empty daysOfWeek array", () => {
    expect(() =>
      generateOccurrences({
        daysOfWeek: [],
        startTime: "09:00",
        endTime: "10:00",
        startsOn: "2026-01-05",
        endsOn: "2026-01-05",
      }),
    ).toThrow();
  });

  it("throws on out-of-range weekday values", () => {
    expect(() =>
      generateOccurrences({
        daysOfWeek: [7],
        startTime: "09:00",
        endTime: "10:00",
        startsOn: "2026-01-05",
        endsOn: "2026-01-05",
      }),
    ).toThrow();
  });

  it("throws when startTime is not before endTime", () => {
    expect(() =>
      generateOccurrences({
        daysOfWeek: [1],
        startTime: "10:00",
        endTime: "10:00",
        startsOn: "2026-01-05",
        endsOn: "2026-01-05",
      }),
    ).toThrow();
  });

  it("throws on a malformed time", () => {
    expect(() =>
      generateOccurrences({
        daysOfWeek: [1],
        startTime: "9:00",
        endTime: "10:00",
        startsOn: "2026-01-05",
        endsOn: "2026-01-05",
      }),
    ).toThrow();
  });

  it("throws when startsOn is after endsOn", () => {
    expect(() =>
      generateOccurrences({
        daysOfWeek: [1],
        startTime: "09:00",
        endTime: "10:00",
        startsOn: "2026-02-01",
        endsOn: "2026-01-05",
      }),
    ).toThrow();
  });

  it("throws on a malformed date", () => {
    expect(() =>
      generateOccurrences({
        daysOfWeek: [1],
        startTime: "09:00",
        endTime: "10:00",
        startsOn: "2026-1-5",
        endsOn: "2026-01-05",
      }),
    ).toThrow();
  });

  it(`throws when the result would exceed MAX_OCCURRENCES (${MAX_OCCURRENCES})`, () => {
    // Every day for >366 days → over the cap.
    expect(() =>
      generateOccurrences({
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        startTime: "09:00",
        endTime: "10:00",
        startsOn: "2026-01-01",
        endsOn: "2027-12-31",
      }),
    ).toThrow();
  });

  it("allows exactly MAX_OCCURRENCES (366) without throwing", () => {
    // 2024 is a leap year: Jan 1 2024 → Dec 31 2024 inclusive = 366 days.
    const occ = generateOccurrences({
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      startTime: "09:00",
      endTime: "10:00",
      startsOn: "2024-01-01",
      endsOn: "2024-12-31",
    });
    expect(occ).toHaveLength(366);
  });
});
