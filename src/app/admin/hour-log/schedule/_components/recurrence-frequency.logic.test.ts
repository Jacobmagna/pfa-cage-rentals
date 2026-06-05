import { describe, expect, it } from "vitest";
import {
  freqIntervalForKind,
  kindForFreqInterval,
  monthlyHint,
  monthlyWeekdayLabel,
  weekdayFromIso,
} from "./recurrence-frequency.logic";

describe("freqIntervalForKind", () => {
  it("maps 'weekly' to weekly/1 (default, identical to today)", () => {
    expect(freqIntervalForKind("weekly", 1)).toEqual({
      frequency: "weekly",
      interval: 1,
    });
  });

  it("maps 'biweekly' to weekly/2", () => {
    expect(freqIntervalForKind("biweekly", 1)).toEqual({
      frequency: "weekly",
      interval: 2,
    });
  });

  it("maps 'everyN' to weekly/N using the typed N", () => {
    expect(freqIntervalForKind("everyN", 3)).toEqual({
      frequency: "weekly",
      interval: 3,
    });
    expect(freqIntervalForKind("everyN", 6)).toEqual({
      frequency: "weekly",
      interval: 6,
    });
  });

  it("clamps a bad/empty N up to 1 and floors fractional N", () => {
    expect(freqIntervalForKind("everyN", 0).interval).toBe(1);
    expect(freqIntervalForKind("everyN", -4).interval).toBe(1);
    expect(freqIntervalForKind("everyN", Number.NaN).interval).toBe(1);
    expect(freqIntervalForKind("everyN", 2.9).interval).toBe(2);
  });

  it("maps 'monthly' to monthly/1", () => {
    expect(freqIntervalForKind("monthly", 1)).toEqual({
      frequency: "monthly",
      interval: 1,
    });
  });
});

describe("kindForFreqInterval (edit prefill round-trip)", () => {
  it("recovers each UI pattern from a stored (frequency, interval)", () => {
    expect(kindForFreqInterval("weekly", 1)).toBe("weekly");
    expect(kindForFreqInterval("weekly", 2)).toBe("biweekly");
    expect(kindForFreqInterval("weekly", 3)).toBe("everyN");
    expect(kindForFreqInterval("weekly", 8)).toBe("everyN");
    expect(kindForFreqInterval("monthly", 1)).toBe("monthly");
    expect(kindForFreqInterval("monthly", 3)).toBe("monthly");
  });

  it("treats a defensive interval ≤ 1 as plain weekly", () => {
    expect(kindForFreqInterval("weekly", 0)).toBe("weekly");
  });
});

describe("weekdayFromIso (UTC parts, no TZ drift)", () => {
  it("derives the weekday from YYYY-MM-DD parts", () => {
    // 2026-01-04 is a Sunday (0); 2026-01-05 a Monday (1).
    expect(weekdayFromIso("2026-01-04")).toBe(0);
    expect(weekdayFromIso("2026-01-05")).toBe(1);
    expect(weekdayFromIso("2026-01-06")).toBe(2); // Tuesday
    expect(weekdayFromIso("2026-01-10")).toBe(6); // Saturday
  });

  it("returns null for malformed or impossible dates", () => {
    expect(weekdayFromIso("")).toBeNull();
    expect(weekdayFromIso("2026-1-5")).toBeNull();
    expect(weekdayFromIso("nope")).toBeNull();
    expect(weekdayFromIso("2026-02-30")).toBeNull();
  });
});

describe("monthlyWeekdayLabel (ordinal = ceil(dayOfMonth/7))", () => {
  it("labels the 1st..5th occurrence of the start-date weekday", () => {
    // Tuesdays of Dec 2026: 1st, 8th, 15th, 22nd, 29th.
    expect(monthlyWeekdayLabel("2026-12-01")).toBe("1st Tuesday");
    expect(monthlyWeekdayLabel("2026-12-08")).toBe("2nd Tuesday");
    expect(monthlyWeekdayLabel("2026-12-15")).toBe("3rd Tuesday");
    expect(monthlyWeekdayLabel("2026-12-22")).toBe("4th Tuesday");
    expect(monthlyWeekdayLabel("2026-12-29")).toBe("5th Tuesday");
  });

  it("computes the ordinal from the day-of-month boundary (ceil/7)", () => {
    expect(monthlyWeekdayLabel("2026-01-07")).toBe("1st Wednesday"); // 7 → 1
    expect(monthlyWeekdayLabel("2026-01-08")).toBe("2nd Thursday"); // 8 → 2
    expect(monthlyWeekdayLabel("2026-01-14")).toBe("2nd Wednesday"); // 14 → 2
    expect(monthlyWeekdayLabel("2026-01-15")).toBe("3rd Thursday"); // 15 → 3
  });

  it("covers every weekday name", () => {
    // 2026-03-01 Sun .. 2026-03-07 Sat — all in the first week (ordinal 1).
    expect(monthlyWeekdayLabel("2026-03-01")).toBe("1st Sunday");
    expect(monthlyWeekdayLabel("2026-03-02")).toBe("1st Monday");
    expect(monthlyWeekdayLabel("2026-03-03")).toBe("1st Tuesday");
    expect(monthlyWeekdayLabel("2026-03-04")).toBe("1st Wednesday");
    expect(monthlyWeekdayLabel("2026-03-05")).toBe("1st Thursday");
    expect(monthlyWeekdayLabel("2026-03-06")).toBe("1st Friday");
    expect(monthlyWeekdayLabel("2026-03-07")).toBe("1st Saturday");
  });

  it("returns '' for malformed/empty input", () => {
    expect(monthlyWeekdayLabel("")).toBe("");
    expect(monthlyWeekdayLabel("garbage")).toBe("");
  });
});

describe("monthlyHint", () => {
  it("wraps the weekday label in a full sentence", () => {
    expect(monthlyHint("2026-12-08")).toBe(
      "On the 2nd Tuesday of each month",
    );
  });

  it("is empty when the start date isn't valid yet", () => {
    expect(monthlyHint("")).toBe("");
  });
});
