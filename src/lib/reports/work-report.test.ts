// Unit tests for the Work-hours tab shaping. Pure module → no mocks.
//
// The load-bearing property is RECONCILIATION: the summary is a roll-up of
// the very rows rendered beneath it, so detail must always add up to
// summary and summary to the grand total. The tests assert that as an
// identity rather than against hardcoded numbers wherever possible — a
// hardcoded expectation can be updated to match a bug; an identity cannot.

import { describe, expect, it } from "vitest";
import { buildWorkReport } from "./work-report";
import type { HourLogFetchRow } from "./hour-log-fetch";

// 2026-05-01 is PDT (UTC-7), so 16:00 UTC → 09:00 PFA.
const DAY = "2026-05-01";
function at(hour: number, minute = 0): Date {
  return new Date(
    Date.UTC(2026, 4, 1, hour + 7, minute, 0, 0), // +7 → PFA local hour
  );
}

function row(overrides: Partial<HourLogFetchRow> = {}): HourLogFetchRow {
  return {
    id: "log-1",
    coachId: "coach-a",
    coachName: "Coach A",
    coachEmail: "a@example.com",
    programId: "prog-1",
    programName: "HS Summer Program",
    startAt: at(9),
    endAt: at(10), // 1 hour
    note: null,
    scheduleNote: null,
    status: "posted",
    decisionReason: null,
    ratePer30MinCents: 1500, // $30/hr
    perSessionRateCents: null,
    ...overrides,
  };
}

describe("buildWorkReport — detail rows", () => {
  it("formats the log in PFA time and computes exact hours", () => {
    const { detail } = buildWorkReport([row()]);
    expect(detail).toHaveLength(1);
    expect(detail[0].date).toBe(DAY);
    expect(detail[0].startTime).toBe("09:00");
    expect(detail[0].endTime).toBe("10:00");
    expect(detail[0].hours).toBe(1);
  });

  it("reports fractional hours exactly — a 45-min log is 0.75", () => {
    const { detail } = buildWorkReport([
      row({ startAt: at(9), endAt: at(9, 45) }),
    ]);
    expect(detail[0].hours).toBe(0.75);
  });

  it("pays hourly logs per-hour × exact duration", () => {
    // $30/hr × 0.75 hr = $22.50
    const { detail } = buildWorkReport([
      row({ startAt: at(9), endAt: at(9, 45) }),
    ]);
    expect(detail[0].payCents).toBe(2250);
  });

  it("pays a per-session log a FLAT amount regardless of duration", () => {
    const short = buildWorkReport([
      row({ startAt: at(9), endAt: at(11), perSessionRateCents: 10000 }),
    ]);
    const long = buildWorkReport([
      row({ startAt: at(9), endAt: at(13), perSessionRateCents: 10000 }),
    ]);
    expect(short.detail[0].payCents).toBe(10000);
    expect(long.detail[0].payCents).toBe(10000);
    // …but the HOURS column still reflects the real duration.
    expect(short.detail[0].hours).toBe(2);
    expect(long.detail[0].hours).toBe(4);
  });

  it("a per-session snapshot beats the hourly one", () => {
    // Both stamped: workPayForLog must take the flat fee, not 2h × $30.
    const { detail } = buildWorkReport([
      row({
        startAt: at(9),
        endAt: at(11),
        ratePer30MinCents: 1500,
        perSessionRateCents: 10000,
      }),
    ]);
    expect(detail[0].payCents).toBe(10000);
  });

  it("pays $0 for a log with no rate stamped, without throwing", () => {
    const { detail, grandTotalCents } = buildWorkReport([
      row({ ratePer30MinCents: null, perSessionRateCents: null }),
    ]);
    expect(detail[0].payCents).toBe(0);
    expect(grandTotalCents).toBe(0);
  });

  it("falls back to the coach email when the name is null", () => {
    const { detail } = buildWorkReport([
      row({ coachName: null, coachEmail: "nameless@example.com" }),
    ]);
    expect(detail[0].coachName).toBe("nameless@example.com");
  });

  it("carries the program name and schedule note through", () => {
    const { detail } = buildWorkReport([
      row({ programName: "HS Summer Softball", scheduleNote: "Ran 30m long" }),
    ]);
    expect(detail[0].programName).toBe("HS Summer Softball");
    expect(detail[0].scheduleNote).toBe("Ran 30m long");
  });
});

describe("buildWorkReport — rejected logs are excluded", () => {
  // Jacob's call: a rejected log is work an admin decided not to pay, so it
  // is not owed and does not belong in a pay total. `fetchHourLogRows`
  // returns them (the Work Log table badges them), so this filter is what
  // keeps Reports honest.
  it("drops a rejected log from detail", () => {
    const { detail } = buildWorkReport([
      row({ id: "ok", status: "posted" }),
      row({ id: "no", status: "rejected" }),
    ]);
    expect(detail.map((d) => d.id)).toEqual(["ok"]);
  });

  it("never counts a rejected log toward pay or hours", () => {
    const { grandTotalCents, grandTotalHours, summary } = buildWorkReport([
      row({ id: "ok", status: "posted" }),
      row({ id: "no", status: "rejected", ratePer30MinCents: 999999 }),
    ]);
    expect(grandTotalCents).toBe(3000); // the posted log only
    expect(grandTotalHours).toBe(1);
    expect(summary[0].entries).toBe(1);
  });

  it("omits a coach entirely when ALL their logs were rejected", () => {
    const { summary, detail } = buildWorkReport([
      row({ id: "no", status: "rejected" }),
    ]);
    expect(detail).toEqual([]);
    expect(summary).toEqual([]);
  });

  it("also drops a held log, if one ever reaches this function", () => {
    // fetchHourLogRows excludes held upstream; this is belt-and-braces so
    // the filter can't silently become status-blind.
    const { detail } = buildWorkReport([row({ id: "h", status: "held" })]);
    expect(detail).toEqual([]);
  });
});

describe("buildWorkReport — summary roll-up", () => {
  it("groups by coach and counts entries", () => {
    const { summary } = buildWorkReport([
      row({ id: "1", coachId: "a", coachName: "Alice" }),
      row({ id: "2", coachId: "a", coachName: "Alice" }),
      row({ id: "3", coachId: "b", coachName: "Bob" }),
    ]);
    expect(summary).toHaveLength(2);
    expect(summary[0].coachName).toBe("Alice");
    expect(summary[0].entries).toBe(2);
    expect(summary[1].entries).toBe(1);
  });

  it("sorts by coach name", () => {
    const { summary } = buildWorkReport([
      row({ id: "1", coachId: "z", coachName: "Zoe" }),
      row({ id: "2", coachId: "a", coachName: "Alice" }),
      row({ id: "3", coachId: "m", coachName: "Mike" }),
    ]);
    expect(summary.map((s) => s.coachName)).toEqual(["Alice", "Mike", "Zoe"]);
  });

  it("returns empty for no rows", () => {
    const report = buildWorkReport([]);
    expect(report.detail).toEqual([]);
    expect(report.summary).toEqual([]);
    expect(report.grandTotalCents).toBe(0);
    expect(report.grandTotalHours).toBe(0);
  });
});

describe("buildWorkReport — RECONCILIATION (the reason this module exists)", () => {
  // A mixed, deliberately awkward set: two coaches, fractional durations,
  // an hourly log, a per-session log, an unrated log, and a rejected one.
  const rows: HourLogFetchRow[] = [
    row({ id: "1", coachId: "a", coachName: "Alice", startAt: at(9), endAt: at(10, 30) }),
    row({ id: "2", coachId: "a", coachName: "Alice", startAt: at(11), endAt: at(11, 45), perSessionRateCents: 10000 }),
    row({ id: "3", coachId: "b", coachName: "Bob", startAt: at(9), endAt: at(12), ratePer30MinCents: 2200 }),
    row({ id: "4", coachId: "b", coachName: "Bob", startAt: at(13), endAt: at(14), ratePer30MinCents: null }),
    row({ id: "5", coachId: "b", coachName: "Bob", status: "rejected" }),
  ];

  it("each summary row equals the sum of that coach's detail rows", () => {
    const { detail, summary } = buildWorkReport(rows);
    for (const s of summary) {
      const mine = detail.filter((d) => d.coachId === s.coachId);
      expect(s.entries).toBe(mine.length);
      expect(s.payCents).toBe(mine.reduce((n, d) => n + d.payCents, 0));
      expect(s.hours).toBeCloseTo(
        mine.reduce((n, d) => n + d.hours, 0),
        10,
      );
    }
  });

  it("the grand total equals the sum of every detail row", () => {
    const { detail, grandTotalCents, grandTotalHours } = buildWorkReport(rows);
    expect(grandTotalCents).toBe(
      detail.reduce((n, d) => n + d.payCents, 0),
    );
    expect(grandTotalHours).toBeCloseTo(
      detail.reduce((n, d) => n + d.hours, 0),
      10,
    );
  });

  it("the grand total equals the sum of every summary row", () => {
    const { summary, grandTotalCents } = buildWorkReport(rows);
    expect(grandTotalCents).toBe(
      summary.reduce((n, s) => n + s.payCents, 0),
    );
  });

  it("every detail row appears under exactly one summary row", () => {
    const { detail, summary } = buildWorkReport(rows);
    const coachIds = new Set(summary.map((s) => s.coachId));
    for (const d of detail) {
      expect(coachIds.has(d.coachId)).toBe(true);
    }
    expect(summary.reduce((n, s) => n + s.entries, 0)).toBe(detail.length);
  });

  it("pay is integer cents everywhere — no float drift into a total", () => {
    const { detail, summary, grandTotalCents } = buildWorkReport(rows);
    for (const d of detail) expect(Number.isInteger(d.payCents)).toBe(true);
    for (const s of summary) expect(Number.isInteger(s.payCents)).toBe(true);
    expect(Number.isInteger(grandTotalCents)).toBe(true);
  });
});
