import { describe, expect, it } from "vitest";
import {
  formatPfaDate,
  formatPfaTime,
  formatPfaTime12h,
  parsePfaInput,
  pfaDayEnd,
  pfaDayStart,
  pfaHour,
  pfaMinute,
  pfaMonthEnd,
  pfaMonthStart,
  pfaWallClockAt,
  pfaWallClockToUtc,
} from "./timezone";

describe("pfaWallClockToUtc", () => {
  it("converts a PDT wall-clock to UTC (May = UTC-7)", () => {
    const d = pfaWallClockToUtc("2026-05-01", "14:30");
    expect(d.toISOString()).toBe("2026-05-01T21:30:00.000Z");
  });

  it("converts a PST wall-clock to UTC (January = UTC-8)", () => {
    const d = pfaWallClockToUtc("2026-01-15", "09:00");
    expect(d.toISOString()).toBe("2026-01-15T17:00:00.000Z");
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

describe("formatPfaTime12h", () => {
  it("formats 12-hour AM/PM with no leading zero on the hour", () => {
    // 09:00 PST -> "9:00 AM"; build the UTC instant from PFA wall-clock.
    expect(formatPfaTime12h(pfaWallClockToUtc("2026-01-15", "09:00"))).toBe(
      "9:00 AM",
    );
    expect(formatPfaTime12h(pfaWallClockToUtc("2026-05-01", "19:30"))).toBe(
      "7:30 PM",
    );
  });

  it("handles noon and midnight edge cases", () => {
    expect(formatPfaTime12h(pfaWallClockToUtc("2026-05-01", "12:00"))).toBe(
      "12:00 PM",
    );
    expect(formatPfaTime12h(pfaWallClockToUtc("2026-05-01", "00:00"))).toBe(
      "12:00 AM",
    );
  });
});

describe("parsePfaInput (form-action alias)", () => {
  it("aliases pfaWallClockToUtc verbatim", () => {
    expect(parsePfaInput("2026-05-24", "09:00").toISOString()).toBe(
      pfaWallClockToUtc("2026-05-24", "09:00").toISOString(),
    );
  });
});

describe("pfaHour / pfaMinute", () => {
  it("returns the PFA wall-clock hour/minute of a UTC instant", () => {
    // 11:30 PFA on May 1 2026 = 18:30 UTC (PDT, UTC-7)
    const d = new Date("2026-05-01T18:30:00Z");
    expect(pfaHour(d)).toBe(11);
    expect(pfaMinute(d)).toBe(30);
  });

  it("works in PST (winter)", () => {
    // 6:15 PFA on Jan 15 2026 = 14:15 UTC (PST, UTC-8)
    const d = new Date("2026-01-15T14:15:00Z");
    expect(pfaHour(d)).toBe(6);
    expect(pfaMinute(d)).toBe(15);
  });
});

describe("pfaWallClockAt", () => {
  it("places (hour, minute) on the PFA day of d", () => {
    // d is "anything during May 1 2026 PFA"
    const d = new Date("2026-05-01T18:30:00Z");
    const target = pfaWallClockAt(d, 9, 0);
    // 9:00 PFA on May 1 = 16:00 UTC (PDT, UTC-7)
    expect(target.toISOString()).toBe("2026-05-01T16:00:00.000Z");
  });

  it("uses the PFA day, not the UTC day", () => {
    // d = "2026-05-31T20:59 PFA" = 2026-06-01T03:59 UTC (PDT, UTC-7)
    const lateNightEt = new Date("2026-06-01T03:59:00Z");
    const target = pfaWallClockAt(lateNightEt, 9, 0);
    // Should be 9:00 PFA on MAY 31, not June 1
    expect(target.toISOString()).toBe("2026-05-31T16:00:00.000Z");
  });
});

describe("pfaDayStart / pfaDayEnd", () => {
  it("returns PFA midnight as a UTC instant", () => {
    const d = new Date("2026-05-01T18:30:00Z");
    const start = pfaDayStart(d);
    // Midnight PFA on May 1 = 07:00 UTC (PDT, UTC-7)
    expect(start.toISOString()).toBe("2026-05-01T07:00:00.000Z");
    expect(formatPfaDate(start)).toBe("2026-05-01");
    expect(formatPfaTime(start)).toBe("00:00");
  });

  it("dayEnd is exactly the next PFA day's start", () => {
    const d = new Date("2026-05-01T18:30:00Z");
    expect(pfaDayEnd(d).toISOString()).toBe(pfaDayStart(new Date("2026-05-02T12:00:00Z")).toISOString());
  });

  it("handles month boundaries (a late-night PT session is still in the right month)", () => {
    // May 31 8:30 PM PFA = June 1 03:30 UTC (PDT, UTC-7)
    const lateNight = new Date("2026-06-01T03:30:00Z");
    expect(formatPfaDate(pfaDayStart(lateNight))).toBe("2026-05-31");
  });
});

describe("pfaMonthStart / pfaMonthEnd", () => {
  it("returns first instant of PFA month", () => {
    const d = new Date("2026-05-15T18:30:00Z");
    const start = pfaMonthStart(d);
    expect(start.toISOString()).toBe("2026-05-01T07:00:00.000Z");
    expect(formatPfaDate(start)).toBe("2026-05-01");
  });

  it("monthEnd is first instant of next PFA month", () => {
    const d = new Date("2026-05-15T18:30:00Z");
    const end = pfaMonthEnd(d);
    // June 1 PFA = May 31 + offset (PDT). Wall clock May 31 → Jun 1 in PFA.
    expect(formatPfaDate(end)).toBe("2026-06-01");
  });

  it("wraps December to January of next year", () => {
    const d = new Date("2026-12-15T18:30:00Z");
    expect(formatPfaDate(pfaMonthEnd(d))).toBe("2027-01-01");
  });

  it("a session at month boundary is bucketed by PFA day, not UTC", () => {
    // Apr 30 8:30 PM PFA = May 1 03:30 UTC (PDT, UTC-7)
    const lateAprilNight = new Date("2026-05-01T03:30:00Z");
    expect(formatPfaDate(pfaMonthStart(lateAprilNight))).toBe("2026-04-01");
  });
});
