// stipend SPEC §5.3 — the pay-period cases, with literals.
//
// ⚠️ EVERY ASSERTION HERE IS TZ-INDEPENDENT BY CONSTRUCTION. Nothing reads the
// runtime clock or the runtime zone: PFA wall-clock instants are built with
// `parsePfaInput`, and the few UTC instants are written as explicit `Z`
// literals precisely so the PFA-vs-UTC divergence can be asserted rather than
// assumed. That is what makes the `TZ=Asia/Tokyo` / `TZ=America/New_York` /
// `TZ=UTC` runs meaningful instead of decorative.
//
// The two blocks that matter most, if this file ever has to be triaged:
//   · "PFA-pinned, not UTC-pinned" — the 7-8 hour window every day in which a
//     UTC-derived boundary puts money in the wrong half-month.
//   · "the periods tile the calendar" — the no-gap/no-overlap property. A gap
//     loses a stipend; an overlap pays it twice.

import { describe, expect, it } from "vitest";
import { parsePfaInput } from "@/lib/timezone";
import {
  isPayPeriodStart,
  nextPayPeriod,
  payPeriodDays,
  payPeriodFor,
  payPeriodLabel,
  payPeriodsBetween,
} from "./pay-period";

/** A PFA wall-clock instant. */
function pfa(date: string, time = "12:00"): Date {
  return parsePfaInput(date, time);
}

describe("payPeriodFor — the 1st-15th / 16th-EOM split", () => {
  it("puts the 1st through the 15th in P1", () => {
    for (const day of ["01", "02", "09", "14", "15"]) {
      const p = payPeriodFor(pfa(`2026-08-${day}`));
      expect(p.half).toBe(1);
      expect(p.key).toBe("2026-08-P1");
    }
  });

  it("puts the 16th through the end of the month in P2", () => {
    for (const day of ["16", "17", "25", "30", "31"]) {
      const p = payPeriodFor(pfa(`2026-08-${day}`));
      expect(p.half).toBe(2);
      expect(p.key).toBe("2026-08-P2");
    }
  });

  it("carries the PFA year and month, 1-indexed", () => {
    const p = payPeriodFor(pfa("2026-01-05"));
    expect({ year: p.year, month: p.month, half: p.half }).toEqual({
      year: 2026,
      month: 1,
      half: 1,
    });
  });
});

describe("the 15th/16th boundary is HALF-OPEN", () => {
  // SPEC §5.3. The statement feature's own worst bug class was a month
  // boundary; this is the same edge one level finer.
  const sixteenth = pfa("2026-08-16", "00:00");

  it("places exactly PFA-midnight on the 16th in P2, never P1", () => {
    expect(payPeriodFor(sixteenth).half).toBe(2);
  });

  it("places the last millisecond of the 15th in P1", () => {
    expect(payPeriodFor(new Date(sixteenth.getTime() - 1)).half).toBe(1);
  });

  it("makes P1's exclusive end exactly P2's inclusive start", () => {
    const p1 = payPeriodFor(pfa("2026-08-03"));
    expect(p1.toDateExclusive.getTime()).toBe(sixteenth.getTime());
    expect(payPeriodFor(pfa("2026-08-20")).fromDate.getTime()).toBe(
      sixteenth.getTime(),
    );
  });
});

describe("PFA-pinned, not UTC-pinned", () => {
  // 🔴 THE ONE THAT CATCHES A SERVER-CLOCK REGRESSION. In August PFA is UTC-7,
  // so 5:00 PM Pacific on the 15th is ALREADY 00:00 UTC on the 16th. A boundary
  // derived from the server's UTC clock puts this instant in P2 and pays it
  // into the wrong half-month. There is a window like this every single day.
  it("keeps a late-on-the-15th PFA instant in P1 even though it is the 16th in UTC", () => {
    const instant = pfa("2026-08-15", "17:00");
    expect(instant.toISOString()).toBe("2026-08-16T00:00:00.000Z");
    expect(payPeriodFor(instant).half).toBe(1);
  });

  it("keeps a late-on-the-31st PFA instant in the SAME month's P2", () => {
    const instant = pfa("2026-08-31", "20:00");
    expect(instant.toISOString()).toBe("2026-09-01T03:00:00.000Z");
    const p = payPeriodFor(instant);
    expect(p.key).toBe("2026-08-P2");
  });

  it("does not treat UTC-midnight on the 1st as the period start", () => {
    // 00:00 UTC on Sep 1 is 5:00 PM PFA on Aug 31 — still August's P2.
    const utcMidnight = new Date("2026-09-01T00:00:00.000Z");
    expect(payPeriodFor(utcMidnight).key).toBe("2026-08-P2");
    expect(isPayPeriodStart(utcMidnight)).toBe(false);
  });
});

describe("period LENGTH — why this is not 'every 15 days' (Mark, R3)", () => {
  it("makes every P1 exactly 15 days", () => {
    for (const month of ["01", "02", "04", "08", "12"]) {
      expect(payPeriodDays(payPeriodFor(pfa(`2026-${month}-05`)))).toBe(15);
    }
  });

  it("makes a 31-day month's P2 SIXTEEN days", () => {
    expect(payPeriodDays(payPeriodFor(pfa("2026-08-20")))).toBe(16);
  });

  it("makes a 30-day month's P2 fifteen days", () => {
    expect(payPeriodDays(payPeriodFor(pfa("2026-04-20")))).toBe(15);
  });

  it("makes a 28-day February's P2 THIRTEEN days — the shortest period", () => {
    expect(payPeriodDays(payPeriodFor(pfa("2026-02-20")))).toBe(13);
  });

  it("makes a leap February's P2 fourteen days", () => {
    expect(payPeriodDays(payPeriodFor(pfa("2028-02-20")))).toBe(14);
    expect(payPeriodLabel(payPeriodFor(pfa("2028-02-20")))).toBe(
      "Feb 16–29, 2028",
    );
  });
});

describe("DST — boundaries stay PFA midnight through both transitions", () => {
  // US DST 2026: spring forward Sun Mar 8, fall back Sun Nov 1. Both land
  // inside a P1, so both periods are 15 CALENDAR days while spanning 359 and
  // 361 elapsed hours respectively.
  it("survives spring forward (the 23-hour day)", () => {
    const p = payPeriodFor(pfa("2026-03-10"));
    expect(p.key).toBe("2026-03-P1");
    expect(p.fromDate.getTime()).toBe(pfa("2026-03-01", "00:00").getTime());
    expect(p.toDateExclusive.getTime()).toBe(
      pfa("2026-03-16", "00:00").getTime(),
    );
    expect(payPeriodDays(p)).toBe(15);
    // 15 days MINUS the lost hour — proof the boundaries are wall-clock, not
    // a fixed 15 × 86_400_000 offset.
    expect(p.toDateExclusive.getTime() - p.fromDate.getTime()).toBe(
      15 * 86_400_000 - 3_600_000,
    );
  });

  it("survives fall back (the 25-hour day)", () => {
    const p = payPeriodFor(pfa("2026-11-10"));
    expect(p.key).toBe("2026-11-P1");
    expect(payPeriodDays(p)).toBe(15);
    expect(p.toDateExclusive.getTime() - p.fromDate.getTime()).toBe(
      15 * 86_400_000 + 3_600_000,
    );
  });
});

describe("nextPayPeriod", () => {
  it("goes P1 → P2 within a month", () => {
    expect(nextPayPeriod(payPeriodFor(pfa("2026-08-05"))).key).toBe("2026-08-P2");
  });

  it("goes P2 → the next month's P1", () => {
    expect(nextPayPeriod(payPeriodFor(pfa("2026-08-20"))).key).toBe("2026-09-P1");
  });

  it("wraps December P2 into the NEXT YEAR's January P1", () => {
    const dec = payPeriodFor(pfa("2026-12-20"));
    const jan = nextPayPeriod(dec);
    expect(jan.key).toBe("2027-01-P1");
    expect(jan.year).toBe(2027);
    expect(jan.fromDate.getTime()).toBe(pfa("2027-01-01", "00:00").getTime());
  });
});

describe("the periods TILE the calendar — no gaps, no overlaps", () => {
  // 🔴 The strongest property in this file. A GAP loses a coach's stipend for a
  // period that belongs to nobody; an OVERLAP earns two stipends for one
  // stretch of time. Walked across a full year so both DST transitions, the
  // short February and the year wrap are all inside the run.
  it("chains each period's exclusive end onto the next period's start", () => {
    let period = payPeriodFor(pfa("2026-01-01", "00:00"));
    for (let i = 0; i < 24; i += 1) {
      const next = nextPayPeriod(period);
      expect(next.fromDate.getTime()).toBe(period.toDateExclusive.getTime());
      period = next;
    }
    expect(period.key).toBe("2027-01-P1");
  });

  it("assigns every day of a year to exactly one period", () => {
    const seen = new Set<string>();
    const cursor = new Date(pfa("2026-01-01", "12:00").getTime());
    for (let i = 0; i < 365; i += 1) {
      const day = new Date(cursor.getTime() + i * 86_400_000);
      const p = payPeriodFor(day);
      // Membership, asserted rather than assumed.
      expect(day.getTime()).toBeGreaterThanOrEqual(p.fromDate.getTime());
      expect(day.getTime()).toBeLessThan(p.toDateExclusive.getTime());
      seen.add(p.key);
    }
    expect(seen.size).toBe(24);
  });
});

describe("payPeriodsBetween", () => {
  it("returns the single period when the range sits inside one", () => {
    const periods = payPeriodsBetween(pfa("2026-08-03"), pfa("2026-08-09"));
    expect(periods.map((p) => p.key)).toEqual(["2026-08-P1"]);
  });

  it("🔴 returns BOTH periods for a range straddling the 15th/16th", () => {
    // SPEC §5.4 — the reader-surprise case. Aug 10-20 is ten days and yields
    // TWO full stipends. Correct, and the reason every stipend line must print
    // its own period label.
    const periods = payPeriodsBetween(pfa("2026-08-10"), pfa("2026-08-20"));
    expect(periods.map((p) => p.key)).toEqual(["2026-08-P1", "2026-08-P2"]);
  });

  it("returns 24 periods for a calendar year", () => {
    const periods = payPeriodsBetween(
      pfa("2026-01-01", "00:00"),
      pfa("2027-01-01", "00:00"),
    );
    expect(periods).toHaveLength(24);
    expect(periods[0].key).toBe("2026-01-P1");
    expect(periods[23].key).toBe("2026-12-P2");
  });

  it("excludes a period that starts exactly at the exclusive end", () => {
    // Half-open at the range level too: a range ending at PFA-midnight on the
    // 16th must not pull in P2.
    const periods = payPeriodsBetween(
      pfa("2026-08-01", "00:00"),
      pfa("2026-08-16", "00:00"),
    );
    expect(periods.map((p) => p.key)).toEqual(["2026-08-P1"]);
  });

  it("includes the period a one-millisecond range touches", () => {
    const from = pfa("2026-08-20", "09:00");
    const periods = payPeriodsBetween(from, new Date(from.getTime() + 1));
    expect(periods.map((p) => p.key)).toEqual(["2026-08-P2"]);
  });

  it("returns [] for an empty or INVERTED range rather than throwing", () => {
    // An inverted from/to is reachable through the existing filter bar
    // (open item 5h); every other surface renders it as "nothing".
    expect(payPeriodsBetween(pfa("2026-08-10"), pfa("2026-08-10"))).toEqual([]);
    expect(payPeriodsBetween(pfa("2026-08-20"), pfa("2026-08-01"))).toEqual([]);
  });

  it("spans a year boundary without a gap", () => {
    const periods = payPeriodsBetween(pfa("2026-12-20"), pfa("2027-01-20"));
    expect(periods.map((p) => p.key)).toEqual([
      "2026-12-P2",
      "2027-01-P1",
      "2027-01-P2",
    ]);
  });
});

describe("payPeriodLabel", () => {
  it("labels P1 and P2 with their real last day", () => {
    expect(payPeriodLabel(payPeriodFor(pfa("2026-08-03")))).toBe("Aug 1–15, 2026");
    expect(payPeriodLabel(payPeriodFor(pfa("2026-08-20")))).toBe("Aug 16–31, 2026");
    expect(payPeriodLabel(payPeriodFor(pfa("2026-04-20")))).toBe("Apr 16–30, 2026");
    expect(payPeriodLabel(payPeriodFor(pfa("2026-02-20")))).toBe("Feb 16–28, 2026");
  });

  it("always names the period's own year", () => {
    expect(payPeriodLabel(payPeriodFor(pfa("2026-12-20")))).toBe("Dec 16–31, 2026");
    expect(payPeriodLabel(payPeriodFor(pfa("2027-01-03")))).toBe("Jan 1–15, 2027");
  });
});

describe("isPayPeriodStart — the §6.3 boundary guard", () => {
  it("accepts PFA-midnight on the 1st and the 16th", () => {
    expect(isPayPeriodStart(pfa("2026-09-01", "00:00"))).toBe(true);
    expect(isPayPeriodStart(pfa("2026-09-16", "00:00"))).toBe(true);
  });

  it("rejects one millisecond after a period start", () => {
    const start = pfa("2026-09-01", "00:00");
    expect(isPayPeriodStart(new Date(start.getTime() + 1))).toBe(false);
  });

  it("rejects any other day, and midday on a boundary day", () => {
    expect(isPayPeriodStart(pfa("2026-09-02", "00:00"))).toBe(false);
    expect(isPayPeriodStart(pfa("2026-09-15", "00:00"))).toBe(false);
    expect(isPayPeriodStart(pfa("2026-09-01", "12:00"))).toBe(false);
  });

  it("🔴 accepts 2026-09-01 — the stipend go-live date (SPEC D9)", () => {
    const goLive = pfa("2026-09-01", "00:00");
    expect(isPayPeriodStart(goLive)).toBe(true);
    expect(payPeriodFor(goLive).key).toBe("2026-09-P1");
  });
});

describe("keys are stable and sortable", () => {
  it("zero-pads the month so string order matches chronological order", () => {
    const keys = payPeriodsBetween(
      pfa("2026-09-20"),
      pfa("2026-11-05"),
    ).map((p) => p.key);
    expect(keys).toEqual(["2026-09-P2", "2026-10-P1", "2026-10-P2", "2026-11-P1"]);
    expect([...keys].sort()).toEqual(keys);
  });
});

describe("invalid input fails loudly", () => {
  it("throws on an invalid Date rather than returning a garbage period", () => {
    const bad = new Date("not-a-date");
    expect(() => payPeriodFor(bad)).toThrow(/invalid Date/);
    expect(() => isPayPeriodStart(bad)).toThrow(/invalid Date/);
    expect(() => payPeriodsBetween(bad, pfa("2026-08-01"))).toThrow(/invalid Date/);
    expect(() => payPeriodsBetween(pfa("2026-08-01"), bad)).toThrow(/invalid Date/);
  });

  it("throws instead of allocating forever on an absurd range", () => {
    expect(() =>
      payPeriodsBetween(new Date("1900-01-01T00:00:00Z"), new Date("2200-01-01T00:00:00Z")),
    ).toThrow(/exceeds 2400 periods/);
  });
});
