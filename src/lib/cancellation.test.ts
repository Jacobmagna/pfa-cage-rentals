import { describe, it, expect } from "vitest";
import {
  LAST_MINUTE_MINUTES,
  SHORT_NOTICE_MINUTES,
  categorizeCancellation,
  isConcerning,
  leadTimeMinutes,
  summarizeByCoach,
  type CoachCancelRow,
} from "./cancellation";

// Fixed reference instants (all UTC). The rental runs 12:00–13:00.
const START = new Date("2026-06-01T12:00:00Z");
const END = new Date("2026-06-01T13:00:00Z");

// Helper: an instant `mins` minutes before START.
function before(mins: number): Date {
  return new Date(START.getTime() - mins * 60000);
}

describe("leadTimeMinutes", () => {
  it("is positive when cancelled before start", () => {
    expect(leadTimeMinutes(START, before(90))).toBe(90);
  });
  it("is zero at start", () => {
    expect(leadTimeMinutes(START, START)).toBe(0);
  });
  it("is negative when cancelled after start", () => {
    expect(leadTimeMinutes(START, new Date(START.getTime() + 30 * 60000))).toBe(
      -30,
    );
  });
  it("rounds to the nearest minute", () => {
    // 90 min 20 sec before start → rounds to 90.
    const c = new Date(START.getTime() - (90 * 60 + 20) * 1000);
    expect(leadTimeMinutes(START, c)).toBe(90);
  });
});

describe("categorizeCancellation boundaries", () => {
  it("advance at lead == 1440 (24h)", () => {
    expect(categorizeCancellation(START, END, before(SHORT_NOTICE_MINUTES))).toBe(
      "advance",
    );
  });
  it("short_notice at lead == 1439 (just under 24h)", () => {
    expect(categorizeCancellation(START, END, before(1439))).toBe(
      "short_notice",
    );
  });
  it("short_notice at lead == 120 (exactly 2h)", () => {
    expect(
      categorizeCancellation(START, END, before(LAST_MINUTE_MINUTES)),
    ).toBe("short_notice");
  });
  it("last_minute at lead == 119 (just under 2h)", () => {
    expect(categorizeCancellation(START, END, before(119))).toBe("last_minute");
  });
  it("last_minute at lead == 0 (right at start boundary is mid_session, but 1 min before is last_minute)", () => {
    expect(categorizeCancellation(START, END, before(1))).toBe("last_minute");
  });
  it("mid_session when cancelledAt == startAt", () => {
    expect(categorizeCancellation(START, END, START)).toBe("mid_session");
  });
  it("mid_session when cancelled between start and end", () => {
    const mid = new Date(START.getTime() + 30 * 60000);
    expect(categorizeCancellation(START, END, mid)).toBe("mid_session");
  });
  it("after_end when cancelledAt == endAt", () => {
    expect(categorizeCancellation(START, END, END)).toBe("after_end");
  });
  it("after_end when cancelled after end", () => {
    const after = new Date(END.getTime() + 60 * 60000);
    expect(categorizeCancellation(START, END, after)).toBe("after_end");
  });
});

describe("isConcerning", () => {
  it("last_minute and mid_session are concerning", () => {
    expect(isConcerning("last_minute")).toBe(true);
    expect(isConcerning("mid_session")).toBe(true);
  });
  it("advance, short_notice, after_end are not concerning", () => {
    expect(isConcerning("advance")).toBe(false);
    expect(isConcerning("short_notice")).toBe(false);
    expect(isConcerning("after_end")).toBe(false);
  });
});

describe("summarizeByCoach", () => {
  it("returns empty for no rows", () => {
    expect(summarizeByCoach([])).toEqual([]);
  });

  it("excludes admin-removed (non-owner) rows from totals", () => {
    const rows: CoachCancelRow[] = [
      {
        coachId: "c1",
        coachName: "Coach One",
        ownerCancellation: true,
        category: "last_minute",
      },
      {
        coachId: "c1",
        coachName: "Coach One",
        ownerCancellation: false, // admin-removed — excluded
        category: "mid_session",
      },
    ];
    const [s] = summarizeByCoach(rows);
    expect(s.total).toBe(1);
    expect(s.lastMinute).toBe(1);
    expect(s.midSession).toBe(0);
  });

  it("computes lateRatePct and repeatOffender", () => {
    const rows: CoachCancelRow[] = [
      {
        coachId: "c1",
        coachName: "Coach One",
        ownerCancellation: true,
        category: "last_minute",
      },
      {
        coachId: "c1",
        coachName: "Coach One",
        ownerCancellation: true,
        category: "mid_session",
      },
      {
        coachId: "c1",
        coachName: "Coach One",
        ownerCancellation: true,
        category: "advance",
      },
      {
        coachId: "c1",
        coachName: "Coach One",
        ownerCancellation: true,
        category: "short_notice",
      },
    ];
    const [s] = summarizeByCoach(rows);
    expect(s.total).toBe(4);
    expect(s.lastMinute).toBe(1);
    expect(s.midSession).toBe(1);
    expect(s.advance).toBe(1);
    expect(s.shortNotice).toBe(1);
    // concerning = 2, lateRate = 2/4 = 50% → repeatOffender.
    expect(s.lateRatePct).toBe(50);
    expect(s.repeatOffender).toBe(true);
  });

  it("does not mark repeatOffender when only 1 concerning even at 100%", () => {
    const rows: CoachCancelRow[] = [
      {
        coachId: "c2",
        coachName: "Coach Two",
        ownerCancellation: true,
        category: "last_minute",
      },
    ];
    const [s] = summarizeByCoach(rows);
    expect(s.lateRatePct).toBe(100);
    expect(s.repeatOffender).toBe(false); // concerning < 2
  });

  it("does not mark repeatOffender when late-rate under 50% even with 2 concerning", () => {
    const rows: CoachCancelRow[] = [
      ...Array.from({ length: 2 }, () => ({
        coachId: "c3",
        coachName: "Coach Three",
        ownerCancellation: true,
        category: "last_minute" as const,
      })),
      ...Array.from({ length: 3 }, () => ({
        coachId: "c3",
        coachName: "Coach Three",
        ownerCancellation: true,
        category: "advance" as const,
      })),
    ];
    const [s] = summarizeByCoach(rows);
    expect(s.total).toBe(5);
    expect(s.lateRatePct).toBe(40); // 2/5
    expect(s.repeatOffender).toBe(false);
  });

  it("sorts by concerning count desc, then late-rate desc", () => {
    const mk = (
      coachId: string,
      category: CoachCancelRow["category"],
    ): CoachCancelRow => ({
      coachId,
      coachName: coachId,
      ownerCancellation: true,
      category,
    });
    const rows: CoachCancelRow[] = [
      // c-low: 1 concerning
      mk("c-low", "last_minute"),
      mk("c-low", "advance"),
      // c-high: 3 concerning
      mk("c-high", "last_minute"),
      mk("c-high", "mid_session"),
      mk("c-high", "last_minute"),
      // c-mid: 2 concerning
      mk("c-mid", "last_minute"),
      mk("c-mid", "mid_session"),
    ];
    const out = summarizeByCoach(rows);
    expect(out.map((s) => s.coachId)).toEqual(["c-high", "c-mid", "c-low"]);
  });
});
