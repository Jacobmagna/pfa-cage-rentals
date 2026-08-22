// Unit tests for the Work-hours tab shaping. Pure module → no mocks.
//
// The load-bearing property is RECONCILIATION: the summary is a roll-up of
// the very rows rendered beneath it, so detail must always add up to
// summary and summary to the grand total. The tests assert that as an
// identity rather than against hardcoded numbers wherever possible — a
// hardcoded expectation can be updated to match a bug; an identity cannot.

import { describe, expect, it } from "vitest";
import { buildWorkReport } from "./work-report";
import type { StipendEarningRow } from "@/lib/stipend/fetch";
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
    // Default false: an ordinary log. The stipend-covered cases set it
    // explicitly, so a fixture never claims coverage by accident.
    stipendCovered: false,
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

/* ── STIPENDS (SPEC §10.3) ───────────────────────────────────────────────── */

describe("🔴 buildWorkReport — stipends are DETAIL ROWS, not a total-only adjustment", () => {
  // Sept 2026 is PDT, so PFA midnight on the 1st is 07:00Z.
  const SEP_P1_START = new Date("2026-09-01T07:00:00.000Z");
  const SEP_P1_END = new Date("2026-09-16T07:00:00.000Z");
  const SEP_P2_START = new Date("2026-09-16T07:00:00.000Z");
  const SEP_P2_END = new Date("2026-10-01T07:00:00.000Z");

  function earning(over: Partial<StipendEarningRow> = {}): StipendEarningRow {
    return {
      id: "earn-1",
      coachId: "coach-a",
      // 🔴 The earning carries its OWN identity, joined at the fetch. It is
      // deliberately NOT borrowed from the log rows: the Work tab is
      // range-filtered while stipends are included by period overlap, so a
      // stipend can appear with none of its coach's logs beside it.
      coachName: "Coach A",
      coachEmail: "a@example.com",
      periodKey: "2026-09-P1",
      periodStart: SEP_P1_START,
      periodEndExclusive: SEP_P1_END,
      amountCents: 250_000,
      ...over,
    };
  }

  it("passing none keeps behaviour byte-identical to before stipends existed", () => {
    // The property that let every existing caller and test stay untouched.
    const withArg = buildWorkReport([row()], []);
    const without = buildWorkReport([row()]);
    expect(withArg).toEqual(without);
  });

  it("🔴 with NO stipends, the fetch's row order survives untouched — including a NULL-named coach", () => {
    // ⚠️ THE TEST ABOVE DOES NOT PROVE THIS, and used not to exist.
    // Comparing `buildWorkReport(rows, [])` against `buildWorkReport(rows)`
    // only checks the DEFAULT PARAMETER; on a one-row fixture it cannot
    // detect a re-sort at all. The re-sort added for stipends DID change
    // this order, in reports with no stipends in them.
    //
    // This array is exactly what `ORDER BY users.name, startAt` hands over.
    // 🔴 Postgres sorts NULLs LAST on ASC — verified against the dev branch —
    // so the nameless coach is the FINAL row, even though her email would
    // sort between the other two. A comparator keyed on the display fallback
    // (`name ?? email`) moved her up into alphabetical position.
    const sqlOrder = [
      row({ id: "A1", coachId: "c1", coachName: "Alice", coachEmail: "alice@x.com", startAt: at(9), endAt: at(10) }),
      row({ id: "A2", coachId: "c1", coachName: "Alice", coachEmail: "alice@x.com", startAt: at(11), endAt: at(12) }),
      row({ id: "Z1", coachId: "c2", coachName: "Zoe", coachEmail: "zoe@x.com", startAt: at(8), endAt: at(9) }),
      row({ id: "N1", coachId: "c3", coachName: null, coachEmail: "mike@x.com", startAt: at(7), endAt: at(8) }),
    ];
    const { detail } = buildWorkReport(sqlOrder);
    expect(detail.map((r) => r.id)).toEqual(["A1", "A2", "Z1", "N1"]);
  });

  it("a stipend sorts into its coach's own block without disturbing the others", () => {
    const sqlOrder = [
      row({ id: "A1", coachId: "c1", coachName: "Alice", coachEmail: "alice@x.com", startAt: at(9), endAt: at(10) }),
      row({ id: "N1", coachId: "c3", coachName: null, coachEmail: "mike@x.com", startAt: at(7), endAt: at(8) }),
    ];
    // Alice earns a stipend for a period AFTER her log's day (log is May,
    // stipend is September), so it sorts below her log — by date, inside her
    // own block.
    const { detail } = buildWorkReport(sqlOrder, [
      earning({ coachId: "c1", coachName: "Alice", coachEmail: "alice@x.com" }),
    ]);
    // The stipend lands with Alice; the NULL-named coach stays last.
    expect(detail.map((r) => r.id)).toEqual(["A1", "earn-1", "N1"]);
    expect(detail[2].coachEmail).toBe("mike@x.com");
  });

  it("🔴 THE INVARIANT: the grand total is the sum of the rows on screen", () => {
    // This module's contract is "the detail rows ARE the summands". A stipend
    // added to the total but not shown would produce rows that visibly fail to
    // add up — the exact failure that contract exists to prevent. Asserted as
    // an identity, so it cannot be updated to match a bug.
    const report = buildWorkReport([row()], [earning()]);
    const summed = report.detail.reduce((t, r) => t + r.payCents, 0);
    expect(report.grandTotalCents).toBe(summed);
    expect(report.detail).toHaveLength(2);
  });

  it("the summary per coach also equals its own detail rows", () => {
    const report = buildWorkReport(
      [row({ id: "l1" }), row({ id: "l2", startAt: at(11), endAt: at(12) })],
      [earning(), earning({ id: "earn-2", periodKey: "2026-09-P2", periodStart: SEP_P2_START, periodEndExclusive: SEP_P2_END })],
    );
    const [only] = report.summary;
    const own = report.detail.filter((r) => r.coachId === only.coachId);
    expect(only.payCents).toBe(own.reduce((t, r) => t + r.payCents, 0));
    expect(only.entries).toBe(own.length);
    // 🔴 Two stipends + two logs; the stipends contribute NO hours.
    expect(only.hours).toBe(own.reduce((t, r) => t + r.hours, 0));
    expect(only.hours).toBe(2);
  });

  it("🔴 a stipend row has no times, no weekday and no hours", () => {
    const { detail } = buildWorkReport([], [earning()]);
    const [s] = detail;
    expect(s.kind).toBe("stipend");
    expect(s.dayOfWeek).toBeNull();
    expect(s.startTime).toBeNull();
    expect(s.endTime).toBeNull();
    // The one honest zero — and every renderer turns it into an em dash.
    expect(s.hours).toBe(0);
    expect(s.ratePer30MinCents).toBeNull();
    expect(s.perSessionRateCents).toBeNull();
  });

  it("🔴 sorts into DATE ORDER, not appended after the logs", () => {
    // 🔴 REGRESSION TEST FOR A DEFECT FOUND BY GENERATING A REAL WORKBOOK AND
    // READING IT. Stipend rows were pushed onto the end of the array, so a
    // Sep-1 stipend printed BELOW two Sep-3 logs and the Date column read
    // 09-03, 09-03, 09-01. On a payroll document that looks like a sorting
    // bug — and a reader who distrusts the ordering distrusts the arithmetic
    // beside it.
    // ⚠️ The fixture puts the stipend in the SAME month as the logs — that is
    // the case the workbook actually rendered wrongly. (An earlier draft of
    // this test used the default September earning against May logs, where
    // "appended last" and "sorted last" are the same answer, so it proved
    // nothing about the ordering at all.)
    const MAY_P1_START = new Date("2026-05-01T07:00:00.000Z");
    const { detail } = buildWorkReport(
      [
        row({ id: "l1", startAt: at(9), endAt: at(10) }),
        row({ id: "l2", startAt: at(19), endAt: at(20) }),
      ],
      [
        earning({
          periodKey: "2026-05-P1",
          periodStart: MAY_P1_START,
          periodEndExclusive: new Date("2026-05-16T07:00:00.000Z"),
        }),
      ],
    );
    const dates = detail.map((d) => d.date);
    expect([...dates].sort()).toEqual(dates);
    // 🔴 The stipend lands FIRST within its own day: it is a whole-period
    // charge, so it belongs above the individual sessions inside that period.
    expect(detail.map((d) => d.kind)).toEqual(["stipend", "log", "log"]);
    expect(detail.map((d) => d.startTime)).toEqual([null, "09:00", "19:00"]);
  });

  it("a report with NO stipends keeps the fetch's original order", () => {
    // The control: the comparator must reproduce (coach, then start) exactly,
    // or every existing report silently re-orders.
    const rows = [
      row({ id: "a", coachId: "c1", coachName: "Alice", startAt: at(9), endAt: at(10) }),
      row({ id: "b", coachId: "c1", coachName: "Alice", startAt: at(11), endAt: at(12) }),
      row({ id: "c", coachId: "c2", coachName: "Bob", coachEmail: "b@x.com", startAt: at(8), endAt: at(9) }),
    ];
    expect(buildWorkReport(rows).detail.map((d) => d.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("🔴 carries its PERIOD LABEL in the row, because a range can hold two", () => {
    // SPEC §5.4: a report filtered Sep 10 → Sep 20 overlaps BOTH half-months,
    // so a coach shows two full stipends. Without the label in the row that
    // reads as a double-count instead of as two periods.
    const { detail } = buildWorkReport(
      [],
      [
        earning(),
        earning({
          id: "earn-2",
          periodKey: "2026-09-P2",
          periodStart: SEP_P2_START,
          periodEndExclusive: SEP_P2_END,
        }),
      ],
    );
    expect(detail.map((d) => d.periodLabel)).toEqual([
      "Sep 1–15, 2026",
      "Sep 16–30, 2026",
    ]);
    // And the label is visible in the column a reader actually looks at.
    expect(detail[0].programName).toBe("Stipend — Sep 1–15, 2026");
    expect(detail[1].programName).toBe("Stipend — Sep 16–30, 2026");
  });

  it("carries real period INSTANTS, so the statement can bucket it", () => {
    const [s] = buildWorkReport([], [earning()]).detail;
    // Never re-parsed from the display string — that is how a PFA-vs-UTC
    // misbucket gets reintroduced.
    expect(s.periodStart?.toISOString()).toBe("2026-09-01T07:00:00.000Z");
    expect(s.periodEndExclusive?.toISOString()).toBe("2026-09-16T07:00:00.000Z");
  });

  it("🔴 names the coach from the EARNING, with NO logs in scope at all", () => {
    // 🔴 THIS IS A REGRESSION TEST FOR A REAL DEFECT FOUND IN THE ADVERSARIAL
    // PASS. The first implementation borrowed the coach's name from whatever
    // log rows were in scope, on the reasoning that "an earning exists only
    // because a covered log posted". That conflates *a log exists* with *a log
    // is inside this filter range*, and the two genuinely diverge:
    //
    //   filter Sep 10–20 → the Sep-3 log that earned the Sep 1–15 stipend is
    //   OUTSIDE the range, while the stipend's period OVERLAPS it and is
    //   therefore included.
    //
    // The result was a raw UUID in the Coach column and an empty Email cell —
    // on a payroll screen and in the exported workbook.
    const { detail } = buildWorkReport(
      [],
      [earning({ coachId: "coach-z", coachName: "Nick Milone", coachEmail: "n@x.com" })],
    );
    expect(detail[0].coachName).toBe("Nick Milone");
    expect(detail[0].coachEmail).toBe("n@x.com");
    expect(detail[0].coachName).not.toMatch(/^[0-9a-f-]{8}-/);
  });

  it("falls back to the email when a coach has no name, like every other surface", () => {
    const { detail } = buildWorkReport(
      [],
      [earning({ coachName: null, coachEmail: "n@x.com" })],
    );
    expect(detail[0].coachName).toBe("n@x.com");
  });

  it("does NOT take the name from a log row that happens to be in scope", () => {
    // The earning is authoritative. If the two ever disagree the join is the
    // one that is right, because it read `users` directly.
    const { detail } = buildWorkReport(
      [row({ coachId: "coach-a", coachName: "Stale Name From Log" })],
      [earning({ coachId: "coach-a", coachName: "Coach A" })],
    );
    const stipend = detail.find((d) => d.kind === "stipend")!;
    expect(stipend.coachName).toBe("Coach A");
  });

  it("🔴 T12 — a COVERED log keeps its hours and is flagged, not hidden", () => {
    // Mark's Q2: he wants to SEE all the hours while they charge him $0.
    const { detail, grandTotalHours, grandTotalCents } = buildWorkReport(
      [
        row({
          id: "covered",
          stipendCovered: true,
          ratePer30MinCents: null,
          perSessionRateCents: null,
        }),
      ],
      [earning()],
    );
    const log = detail.find((d) => d.kind === "log")!;
    expect(log.stipendCovered).toBe(true);
    expect(log.hours).toBe(1); // real hours, untouched
    expect(log.payCents).toBe(0); // and no pay
    expect(grandTotalHours).toBe(1);
    // The stipend is the pay — the whole total, with the hours charging $0.
    expect(grandTotalCents).toBe(250_000);
  });

  it("an UNCOVERED log on the same coach still pays hourly ON TOP (T11)", () => {
    // The positive control: without it, "covered pays $0" could be passing
    // because nothing pays anything.
    const { grandTotalCents } = buildWorkReport(
      [
        row({ id: "covered", stipendCovered: true, ratePer30MinCents: null }),
        row({
          id: "extra",
          startAt: at(19),
          endAt: at(21),
          ratePer30MinCents: 1500,
        }),
      ],
      [earning()],
    );
    // $2,500 stipend + 2 h × $30 = $2,560.
    expect(grandTotalCents).toBe(250_000 + 6_000);
  });

  it("keeps two coaches' stipends in their own summary rows", () => {
    const { summary } = buildWorkReport(
      [
        row({ coachId: "coach-a", coachName: "Coach A" }),
        row({
          id: "l2",
          coachId: "coach-b",
          coachName: "Coach B",
          coachEmail: "b@example.com",
        }),
      ],
      [
        earning({ coachId: "coach-a" }),
        earning({ id: "e2", coachId: "coach-b", amountCents: 100_000 }),
      ],
    );
    const a = summary.find((s) => s.coachId === "coach-a")!;
    const b = summary.find((s) => s.coachId === "coach-b")!;
    expect(a.payCents).toBe(250_000 + 3_000);
    expect(b.payCents).toBe(100_000 + 3_000);
  });
});
