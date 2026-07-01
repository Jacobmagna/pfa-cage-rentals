import { afterEach, describe, expect, it, vi } from "vitest";
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

// Regression: formatPfaDate must NOT depend on a locale's default date
// FORMAT. Some browsers ignore "en-CA"'s YYYY-MM-DD short format and fall
// back to US "M/D/YYYY" from toLocaleDateString, which produced strings like
// "7/1/2026" that then crashed every downstream parsePfaInput consumer (the
// recurring-block dialogs white-screened). The fix derives the ISO string
// from pfaParts (formatToParts named fields), so simulating that fallback by
// stubbing toLocaleDateString to return US format must NOT change the output.
describe("formatPfaDate locale-fallback resilience", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns ISO even when toLocaleDateString falls back to US format", () => {
    const spy = vi
      .spyOn(Date.prototype, "toLocaleDateString")
      .mockReturnValue("7/1/2026");
    const utc = pfaWallClockToUtc("2026-07-01", "12:00");
    // Sanity: the stub is actually active (proves the old code path would break).
    expect(utc.toLocaleDateString()).toBe("7/1/2026");
    expect(formatPfaDate(utc)).toBe("2026-07-01");
    expect(formatPfaDate(utc)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    spy.mockRestore();
  });
});

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

  it("dayEnd is next-day PFA midnight regardless of time-of-day", () => {
    // Three instants all on the SAME PFA calendar day (Mon 2026-05-04):
    //   early morning, midday, and LATE EVENING (11:30 PM PT).
    // All must yield the SAME next-day-00:00 result (Tue 2026-05-05
    // 00:00 PT = 07:00 UTC, PDT UTC-7) — proving the late-evening input
    // no longer overshoots to Wed.
    const expected = "2026-05-05T07:00:00.000Z";
    // 6:15 AM PT Mon = 13:15 UTC
    const earlyMorning = new Date("2026-05-04T13:15:00Z");
    // 1:00 PM PT Mon = 20:00 UTC
    const midday = new Date("2026-05-04T20:00:00Z");
    // 11:30 PM PT Mon = Tue 06:30 UTC (the bug case)
    const lateEvening = new Date("2026-05-05T06:30:00Z");
    // Sanity: all three are the same PFA calendar day.
    expect(formatPfaDate(earlyMorning)).toBe("2026-05-04");
    expect(formatPfaDate(midday)).toBe("2026-05-04");
    expect(formatPfaDate(lateEvening)).toBe("2026-05-04");
    expect(pfaDayEnd(earlyMorning).toISOString()).toBe(expected);
    expect(pfaDayEnd(midday).toISOString()).toBe(expected);
    expect(pfaDayEnd(lateEvening).toISOString()).toBe(expected);
    // And the result is in fact a PFA midnight on the next day.
    expect(formatPfaDate(pfaDayEnd(lateEvening))).toBe("2026-05-05");
    expect(formatPfaTime(pfaDayEnd(lateEvening))).toBe("00:00");
  });

  it("dayEnd snaps across the March spring-forward (23h day)", () => {
    // 2026 US DST begins Sun 2026-03-08 02:00 PT (PST UTC-8 -> PDT UTC-7).
    // Late-evening input on the SHORT (23h) day, Sun 2026-03-08 11:30 PM
    // PDT = Mon 2026-03-09 06:30 UTC. Next-day 00:00 PT (PDT, UTC-7) =
    // Mon 2026-03-09 07:00 UTC.
    const lateEvening = new Date("2026-03-09T06:30:00Z");
    expect(formatPfaDate(lateEvening)).toBe("2026-03-08");
    const end = pfaDayEnd(lateEvening);
    expect(end.toISOString()).toBe("2026-03-09T07:00:00.000Z");
    expect(formatPfaDate(end)).toBe("2026-03-09");
    expect(formatPfaTime(end)).toBe("00:00");
  });

  it("dayEnd snaps across the November fall-back (25h day)", () => {
    // 2026 US DST ends Sun 2026-11-01 02:00 PT (PDT UTC-7 -> PST UTC-8).
    // Late-evening input on the LONG (25h) day, Sun 2026-11-01 11:30 PM
    // PST = Mon 2026-11-02 07:30 UTC. Next-day 00:00 PT (PST, UTC-8) =
    // Mon 2026-11-02 08:00 UTC.
    const lateEvening = new Date("2026-11-02T07:30:00Z");
    expect(formatPfaDate(lateEvening)).toBe("2026-11-01");
    const end = pfaDayEnd(lateEvening);
    expect(end.toISOString()).toBe("2026-11-02T08:00:00.000Z");
    expect(formatPfaDate(end)).toBe("2026-11-02");
    expect(formatPfaTime(end)).toBe("00:00");
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
