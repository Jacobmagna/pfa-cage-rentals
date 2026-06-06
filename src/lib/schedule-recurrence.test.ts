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

  it("produces DST-correct wall-clock times (PDT in March, PST in November)", () => {
    // A Wednesday after the spring-forward (2026-03-11, PDT) and a
    // Wednesday after fall-back (2026-11-04, PST). The wall-clock
    // 09:00–10:00 PFA time must round-trip regardless of the UTC offset.
    const occ = generateOccurrences({
      daysOfWeek: [3],
      startTime: "09:00",
      endTime: "10:00",
      // 2026-03-11 is a Wed (PDT), 2026-11-04 is a Wed (PST). Range spans
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
    // Sanity: the March (PDT) occurrence and the November (PST)
    // occurrence have different UTC hours despite identical wall-clock.
    const march = occ.find((o) => o.date === "2026-03-11");
    const november = occ.find((o) => o.date === "2026-11-04");
    expect(march).toBeDefined();
    expect(november).toBeDefined();
    // PDT is UTC-7 → 09:00 PDT = 16:00Z; PST is UTC-8 → 09:00 PST = 17:00Z.
    expect(march!.startAt.getUTCHours()).toBe(16);
    expect(november!.startAt.getUTCHours()).toBe(17);
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

// ---------------------------------------------------------------------------
// RECUR-a W3.1a: frequency + interval.
//
// 2026-01-05 is a Monday; 2026-01-04 is a Sunday (week start). Weekly week
// indexes below are relative to the Sunday week containing startsOn.
describe("generateOccurrences — weekly interval", () => {
  it("interval 1 is identical to omitting frequency/interval (back-compat)", () => {
    const args = {
      daysOfWeek: [1],
      startTime: "09:00",
      endTime: "10:00",
      startsOn: "2026-01-05",
      endsOn: "2026-02-09",
    };
    const legacy = generateOccurrences(args);
    const explicit = generateOccurrences({
      ...args,
      frequency: "weekly" as const,
      interval: 1,
    });
    const expected = [
      "2026-01-05",
      "2026-01-12",
      "2026-01-19",
      "2026-01-26",
      "2026-02-02",
      "2026-02-09",
    ];
    expect(legacy.map((o) => o.date)).toEqual(expected);
    // Back-compat: explicit weekly/1 must produce byte-identical output to
    // the legacy (omitted) call, including the resolved UTC instants.
    expect(explicit).toEqual(legacy);
  });

  it("interval 2 = every other week (week indexes 0,2,4 included; 1,3,5 excluded)", () => {
    const occ = generateOccurrences({
      daysOfWeek: [1],
      startTime: "09:00",
      endTime: "10:00",
      startsOn: "2026-01-05",
      endsOn: "2026-02-09",
      frequency: "weekly",
      interval: 2,
    });
    // Mondays in weeks 0 (01-05), 2 (01-19), 4 (02-02). 01-12, 01-26,
    // 02-09 fall in odd weeks and are skipped.
    expect(occ.map((o) => o.date)).toEqual([
      "2026-01-05",
      "2026-01-19",
      "2026-02-02",
    ]);
  });

  it("interval 3 = every third week", () => {
    const occ = generateOccurrences({
      daysOfWeek: [1],
      startTime: "09:00",
      endTime: "10:00",
      startsOn: "2026-01-05",
      endsOn: "2026-03-02",
      frequency: "weekly",
      interval: 3,
    });
    // Weeks 0 (01-05), 3 (01-26), 6 (02-16). Next would be week 9 (03-09),
    // beyond endsOn.
    expect(occ.map((o) => o.date)).toEqual([
      "2026-01-05",
      "2026-01-26",
      "2026-02-16",
    ]);
  });

  it("interval 2 respects multiple weekdays within each included week", () => {
    // Mon (1) + Wed (3), every other week. Week 0 (01-05/01-07) included,
    // week 1 (01-12/01-14) skipped, week 2 (01-19/01-21) included.
    const occ = generateOccurrences({
      daysOfWeek: [1, 3],
      startTime: "16:00",
      endTime: "17:30",
      startsOn: "2026-01-05",
      endsOn: "2026-01-25",
      frequency: "weekly",
      interval: 2,
    });
    expect(occ.map((o) => o.date)).toEqual([
      "2026-01-05",
      "2026-01-07",
      "2026-01-19",
      "2026-01-21",
    ]);
  });

  it("interval 2 honors skipDates and the endsOn boundary", () => {
    const occ = generateOccurrences({
      daysOfWeek: [1],
      startTime: "09:00",
      endTime: "10:00",
      startsOn: "2026-01-05",
      endsOn: "2026-02-02", // boundary: 02-02 is an included (week 4) Monday
      frequency: "weekly",
      interval: 2,
      skipDates: ["2026-01-19"],
    });
    expect(occ.map((o) => o.date)).toEqual(["2026-01-05", "2026-02-02"]);
  });
});

describe("generateOccurrences — monthly same-weekday", () => {
  it('"2nd Tuesday" each month derives weekday+ordinal from startsOn', () => {
    // 2026-01-13 is the 2nd Tuesday of January 2026 (Tuesdays: 6,13,20,27).
    const occ = generateOccurrences({
      daysOfWeek: [2],
      startTime: "18:00",
      endTime: "19:30",
      startsOn: "2026-01-13",
      endsOn: "2026-06-30",
      frequency: "monthly",
      interval: 1,
    });
    expect(occ.map((o) => o.date)).toEqual([
      "2026-01-13", // 2nd Tue Jan
      "2026-02-10", // 2nd Tue Feb
      "2026-03-10", // 2nd Tue Mar
      "2026-04-14", // 2nd Tue Apr
      "2026-05-12", // 2nd Tue May
      "2026-06-09", // 2nd Tue Jun
    ]);
    // DST sanity: Jan is PST, Jun is PDT — wall-clock must round-trip.
    for (const o of occ) {
      expect(formatPfaTime(o.startAt)).toBe("18:00");
      expect(formatPfaDate(o.startAt)).toBe(o.date);
    }
  });

  it("skips months that lack the ordinal (no 5th Tuesday)", () => {
    // 2026-03-31 is the 5th Tuesday of March 2026 (Tue: 3,10,17,24,31).
    // April 2026 has only 4 Tuesdays (7,14,21,28) → no 5th, skipped.
    // June 2026 has a 5th Tuesday (2,9,16,23,30). May has 4 (5,12,19,26).
    const occ = generateOccurrences({
      daysOfWeek: [2],
      startTime: "09:00",
      endTime: "10:00",
      startsOn: "2026-03-31",
      endsOn: "2026-07-31",
      frequency: "monthly",
      interval: 1,
    });
    expect(occ.map((o) => o.date)).toEqual([
      "2026-03-31", // 5th Tue Mar
      "2026-06-30", // 5th Tue Jun (Apr & May have no 5th Tue → skipped)
    ]);
  });

  it("interval 2 = every other month, same weekday/ordinal", () => {
    // 2nd Tuesday, every other month from Jan 2026.
    const occ = generateOccurrences({
      daysOfWeek: [2],
      startTime: "09:00",
      endTime: "10:00",
      startsOn: "2026-01-13",
      endsOn: "2026-07-31",
      frequency: "monthly",
      interval: 2,
    });
    expect(occ.map((o) => o.date)).toEqual([
      "2026-01-13", // Jan
      "2026-03-10", // Mar
      "2026-05-12", // May
      "2026-07-14", // Jul
    ]);
  });

  it("monthly honors skipDates and the startsOn lower bound", () => {
    const occ = generateOccurrences({
      daysOfWeek: [2],
      startTime: "09:00",
      endTime: "10:00",
      startsOn: "2026-01-13",
      endsOn: "2026-04-30",
      frequency: "monthly",
      interval: 1,
      skipDates: ["2026-02-10"],
    });
    expect(occ.map((o) => o.date)).toEqual([
      "2026-01-13",
      "2026-03-10",
      "2026-04-14",
    ]);
  });

  it("monthly still enforces MAX_OCCURRENCES is never exceeded (small N)", () => {
    // A single year of a monthly recurrence is at most 12 — well under the
    // cap. Assert the count is bounded and correct rather than throwing.
    const occ = generateOccurrences({
      daysOfWeek: [2],
      startTime: "09:00",
      endTime: "10:00",
      startsOn: "2026-01-13",
      endsOn: "2026-12-31",
      frequency: "monthly",
      interval: 1,
    });
    expect(occ.length).toBeLessThanOrEqual(MAX_OCCURRENCES);
    expect(occ).toHaveLength(12);
  });
});

describe("generateOccurrences — interval/frequency validation", () => {
  it("rejects interval 0", () => {
    expect(() =>
      generateOccurrences({
        daysOfWeek: [1],
        startTime: "09:00",
        endTime: "10:00",
        startsOn: "2026-01-05",
        endsOn: "2026-02-01",
        frequency: "weekly",
        interval: 0,
      }),
    ).toThrow();
  });

  it("rejects a negative interval", () => {
    expect(() =>
      generateOccurrences({
        daysOfWeek: [1],
        startTime: "09:00",
        endTime: "10:00",
        startsOn: "2026-01-05",
        endsOn: "2026-02-01",
        frequency: "monthly",
        interval: -2,
      }),
    ).toThrow();
  });

  it("rejects a non-integer interval", () => {
    expect(() =>
      generateOccurrences({
        daysOfWeek: [1],
        startTime: "09:00",
        endTime: "10:00",
        startsOn: "2026-01-05",
        endsOn: "2026-02-01",
        frequency: "weekly",
        interval: 1.5,
      }),
    ).toThrow();
  });
});
