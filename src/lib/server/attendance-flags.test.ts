// Unit tests for the pure over-cap red-flag logic (FEAT-11). Pure
// module → no DB, no mocks. Mirrors src/lib/reports/aggregate.test.ts.
//
// Proves the settled decisions: present-only counting (DEC-26),
// Sunday–Saturday weeks vs calendar months (DEC-03) by pure calendar
// arithmetic on the "YYYY-MM-DD" sessionDate (including week buckets that
// cross a month/year boundary), (cap+1)th-and-beyond flagged, uncapped →
// no flags, exactly-at-cap → no flags.

import { describe, expect, it } from "vitest";
import { computeOverCapFlags, monthKey, weekKey } from "./attendance-flags";
import type {
  GridAthlete,
  GridSession,
} from "@/lib/server/attendance-grid";

const ATH: GridAthlete = { id: "a1", firstName: "Sam", lastName: "Rivera" };

// Helper: build sessions from a list of "YYYY-MM-DD" dates, id = "s-<date>".
function sessions(dates: string[]): GridSession[] {
  return dates.map((d) => ({ id: `s-${d}`, sessionDate: d }));
}

// Helper: present map for one athlete from a list of "date → present".
function presentFor(
  athleteId: string,
  marks: Record<string, boolean>,
): Record<string, Record<string, boolean>> {
  const inner: Record<string, boolean> = {};
  for (const [date, p] of Object.entries(marks)) inner[`s-${date}`] = p;
  return { [athleteId]: inner };
}

describe("period key helpers", () => {
  it("monthKey = YYYY-MM slice", () => {
    expect(monthKey("2026-06-15")).toBe("2026-06");
    expect(monthKey("2026-01-01")).toBe("2026-01");
  });

  it("weekKey rolls back to the Sunday (Sun–Sat)", () => {
    // 2026-06-01 is a Monday → Sunday is 2026-05-31 (crosses month).
    expect(weekKey("2026-06-01")).toBe("2026-05-31");
    expect(weekKey("2026-06-02")).toBe("2026-05-31"); // Tue same week
    expect(weekKey("2026-06-06")).toBe("2026-05-31"); // Sat same week
    expect(weekKey("2026-06-07")).toBe("2026-06-07"); // Sun → itself
  });

  it("weekKey handles a year-boundary week", () => {
    // 2027-01-01 is a Friday → Sunday is 2026-12-27.
    expect(weekKey("2027-01-01")).toBe("2026-12-27");
    expect(weekKey("2026-12-27")).toBe("2026-12-27"); // Sun → itself
  });
});

describe("computeOverCapFlags — week cap", () => {
  it("flags only the 3rd present of 3 in one Sun–Sat week (cap=2)", () => {
    // 2026-06-07 Sun, 06-09 Tue, 06-10 Wed — all in week of 2026-06-07.
    const dates = ["2026-06-07", "2026-06-09", "2026-06-10"];
    const flags = computeOverCapFlags({
      athletes: [ATH],
      sessions: sessions(dates),
      present: presentFor("a1", {
        "2026-06-07": true,
        "2026-06-09": true,
        "2026-06-10": true,
      }),
      cap: 2,
      capPeriod: "week",
    });

    expect(flags.a1?.["s-2026-06-07"]).toBeUndefined();
    expect(flags.a1?.["s-2026-06-09"]).toBeUndefined();
    const over = flags.a1?.["s-2026-06-10"];
    expect(over).toEqual({
      periodLabel: "Week of Jun 7",
      indexInPeriod: 3,
      periodPresentCount: 3,
      cap: 2,
    });
  });

  it("counts per-week, not merged, across a week/month boundary", () => {
    // Week of 2026-05-31: 05-31 (Sun), 06-01, 06-02, 06-03 → 4 present,
    //   cap=2 → 06-02 (#3) and 06-03 (#4) flagged.
    // Week of 2026-06-07: 06-08 → 1 present → none flagged.
    const dates = [
      "2026-05-31",
      "2026-06-01",
      "2026-06-02",
      "2026-06-03",
      "2026-06-08",
    ];
    const flags = computeOverCapFlags({
      athletes: [ATH],
      sessions: sessions(dates),
      present: presentFor("a1", {
        "2026-05-31": true,
        "2026-06-01": true,
        "2026-06-02": true,
        "2026-06-03": true,
        "2026-06-08": true,
      }),
      cap: 2,
      capPeriod: "week",
    });

    expect(flags.a1?.["s-2026-05-31"]).toBeUndefined();
    expect(flags.a1?.["s-2026-06-01"]).toBeUndefined();
    expect(flags.a1?.["s-2026-06-02"]).toMatchObject({
      periodLabel: "Week of May 31",
      indexInPeriod: 3,
      periodPresentCount: 4,
      cap: 2,
    });
    expect(flags.a1?.["s-2026-06-03"]).toMatchObject({
      indexInPeriod: 4,
      periodPresentCount: 4,
    });
    // The single session in the next week is never flagged.
    expect(flags.a1?.["s-2026-06-08"]).toBeUndefined();
  });
});

describe("computeOverCapFlags — month cap", () => {
  it("flags the 5th present of 5 in one month (cap=4)", () => {
    const dates = [
      "2026-06-02",
      "2026-06-09",
      "2026-06-16",
      "2026-06-23",
      "2026-06-30",
    ];
    const flags = computeOverCapFlags({
      athletes: [ATH],
      sessions: sessions(dates),
      present: presentFor(
        "a1",
        Object.fromEntries(dates.map((d) => [d, true])),
      ),
      cap: 4,
      capPeriod: "month",
    });

    for (const d of dates.slice(0, 4)) {
      expect(flags.a1?.[`s-${d}`]).toBeUndefined();
    }
    expect(flags.a1?.["s-2026-06-30"]).toEqual({
      periodLabel: "June 2026",
      indexInPeriod: 5,
      periodPresentCount: 5,
      cap: 4,
    });
  });

  it("counts months separately (different months not merged)", () => {
    // May: 3 present (cap=2) → 3rd flagged. June: 1 present → none.
    const dates = [
      "2026-05-04",
      "2026-05-11",
      "2026-05-18",
      "2026-06-01",
    ];
    const flags = computeOverCapFlags({
      athletes: [ATH],
      sessions: sessions(dates),
      present: presentFor(
        "a1",
        Object.fromEntries(dates.map((d) => [d, true])),
      ),
      cap: 2,
      capPeriod: "month",
    });

    expect(flags.a1?.["s-2026-05-04"]).toBeUndefined();
    expect(flags.a1?.["s-2026-05-11"]).toBeUndefined();
    expect(flags.a1?.["s-2026-05-18"]).toMatchObject({
      periodLabel: "May 2026",
      indexInPeriod: 3,
      periodPresentCount: 3,
    });
    expect(flags.a1?.["s-2026-06-01"]).toBeUndefined();
  });
});

describe("computeOverCapFlags — present-only (DEC-26)", () => {
  it("absent sessions don't count toward the index and are never flagged", () => {
    // Present on 06-07, 06-09, 06-10; absent on 06-08, 06-11. cap=2.
    // Only 3 present → 3rd present (06-10) is the only flag; the absent
    // sessions neither count nor get flagged.
    const dates = [
      "2026-06-07",
      "2026-06-08",
      "2026-06-09",
      "2026-06-10",
      "2026-06-11",
    ];
    const flags = computeOverCapFlags({
      athletes: [ATH],
      sessions: sessions(dates),
      present: presentFor("a1", {
        "2026-06-07": true,
        "2026-06-08": false,
        "2026-06-09": true,
        "2026-06-10": true,
        "2026-06-11": false,
      }),
      cap: 2,
      capPeriod: "week",
    });

    expect(flags.a1?.["s-2026-06-08"]).toBeUndefined(); // absent
    expect(flags.a1?.["s-2026-06-11"]).toBeUndefined(); // absent
    expect(flags.a1?.["s-2026-06-10"]).toMatchObject({
      indexInPeriod: 3,
      periodPresentCount: 3,
    });
  });
});

describe("computeOverCapFlags — edges", () => {
  it("uncapped (cap=null) → {}", () => {
    const dates = ["2026-06-07", "2026-06-08", "2026-06-09"];
    expect(
      computeOverCapFlags({
        athletes: [ATH],
        sessions: sessions(dates),
        present: presentFor(
          "a1",
          Object.fromEntries(dates.map((d) => [d, true])),
        ),
        cap: null,
        capPeriod: null,
      }),
    ).toEqual({});
  });

  it("exactly at cap → no flags", () => {
    const dates = ["2026-06-07", "2026-06-09"];
    const flags = computeOverCapFlags({
      athletes: [ATH],
      sessions: sessions(dates),
      present: presentFor("a1", {
        "2026-06-07": true,
        "2026-06-09": true,
      }),
      cap: 2,
      capPeriod: "week",
    });
    expect(flags).toEqual({});
  });

  it("multiple over: 4 present cap=2 → 3rd AND 4th flagged", () => {
    const dates = ["2026-06-07", "2026-06-08", "2026-06-09", "2026-06-10"];
    const flags = computeOverCapFlags({
      athletes: [ATH],
      sessions: sessions(dates),
      present: presentFor(
        "a1",
        Object.fromEntries(dates.map((d) => [d, true])),
      ),
      cap: 2,
      capPeriod: "week",
    });

    expect(flags.a1?.["s-2026-06-07"]).toBeUndefined();
    expect(flags.a1?.["s-2026-06-08"]).toBeUndefined();
    expect(flags.a1?.["s-2026-06-09"]).toMatchObject({
      indexInPeriod: 3,
      periodPresentCount: 4,
      cap: 2,
    });
    expect(flags.a1?.["s-2026-06-10"]).toMatchObject({
      indexInPeriod: 4,
      periodPresentCount: 4,
      cap: 2,
    });
  });

  it("isolates flags per athlete", () => {
    const ath2: GridAthlete = { id: "a2", firstName: "Lee", lastName: "Park" };
    const dates = ["2026-06-07", "2026-06-09", "2026-06-10"];
    const flags = computeOverCapFlags({
      athletes: [ATH, ath2],
      sessions: sessions(dates),
      present: {
        // a1: 3 present → over. a2: 1 present → fine.
        a1: { "s-2026-06-07": true, "s-2026-06-09": true, "s-2026-06-10": true },
        a2: { "s-2026-06-07": true },
      },
      cap: 2,
      capPeriod: "week",
    });

    expect(flags.a1?.["s-2026-06-10"]).toBeDefined();
    expect(flags.a2).toBeUndefined();
  });
});
