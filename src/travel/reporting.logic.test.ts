import { describe, expect, it } from "vitest";
import {
  DEFAULT_GRACE_DAYS,
  onTimeBonusTier,
  onTimeCollectionRate,
  parseReportPeriod,
  sumCents,
} from "./reporting.logic";

// Pure-module unit tests for the finances reporting helpers (no DB I/O). Unlike
// plans.ts, reporting.logic.ts imports nothing from "@/db", so it can be
// imported statically at the top of the file.

describe("parseReportPeriod", () => {
  it("both empty → all-time (nulls, 'All time')", () => {
    const p = parseReportPeriod();
    expect(p.fromDate).toBeNull();
    expect(p.toDate).toBeNull();
    expect(p.label).toBe("All time");
  });

  it("parses `from` at UTC-midnight", () => {
    const p = parseReportPeriod("2026-07-01", undefined);
    expect(p.fromDate?.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(p.toDate).toBeNull();
    expect(p.label).toBe("From 2026-07-01");
  });

  it("`to` is the EXCLUSIVE next-day UTC-midnight (whole `to` day covered)", () => {
    const p = parseReportPeriod(undefined, "2026-07-31");
    expect(p.fromDate).toBeNull();
    // Aug 1 midnight — a payment at 2026-07-31T23:59 is `< toDate` (included).
    expect(p.toDate?.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(p.label).toBe("Through 2026-07-31");
  });

  it("both bounds → range label", () => {
    const p = parseReportPeriod("2026-07-01", "2026-07-31");
    expect(p.fromDate?.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(p.toDate?.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(p.label).toBe("2026-07-01 – 2026-07-31");
  });

  it("invalid / impossible dates fall back to all-time (no throw)", () => {
    expect(parseReportPeriod("garbage", "2026-13-99").label).toBe("All time");
    expect(parseReportPeriod("2026-7-1", "").fromDate).toBeNull(); // not zero-padded
    expect(parseReportPeriod("2026-02-30", undefined).fromDate).toBeNull(); // Feb 30
  });

  it("does NOT swap an inverted range (empty result is the honest answer)", () => {
    const p = parseReportPeriod("2026-08-01", "2026-07-01");
    expect(p.fromDate?.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(p.toDate?.toISOString()).toBe("2026-07-02T00:00:00.000Z");
  });
});

describe("onTimeCollectionRate", () => {
  const d = (s: string) => new Date(s);

  it("null rate when nothing is due (avoids 0/0)", () => {
    expect(onTimeCollectionRate([], 5)).toEqual({
      dueCount: 0,
      onTimeCount: 0,
      ratePct: null,
    });
  });

  it("skips installments with no dueDate (not 'due')", () => {
    const r = onTimeCollectionRate(
      [{ dueDate: null, paidDate: d("2026-07-01") }],
      5,
    );
    expect(r.dueCount).toBe(0);
    expect(r.ratePct).toBeNull();
  });

  it("paid exactly on the due date is on time", () => {
    const r = onTimeCollectionRate(
      [{ dueDate: d("2026-07-10"), paidDate: d("2026-07-10") }],
      5,
    );
    expect(r).toEqual({ dueCount: 1, onTimeCount: 1, ratePct: 100 });
  });

  it("paid within the grace window is on time; just past it is not", () => {
    const due = d("2026-07-10T00:00:00.000Z");
    const within = onTimeCollectionRate(
      [{ dueDate: due, paidDate: d("2026-07-15T00:00:00.000Z") }], // +5d exactly
      DEFAULT_GRACE_DAYS,
    );
    expect(within.onTimeCount).toBe(1);
    const past = onTimeCollectionRate(
      [{ dueDate: due, paidDate: d("2026-07-15T00:00:00.001Z") }], // +5d + 1ms
      DEFAULT_GRACE_DAYS,
    );
    expect(past.onTimeCount).toBe(0);
  });

  it("unpaid (null paidDate) counts as due but not on time", () => {
    const r = onTimeCollectionRate(
      [{ dueDate: d("2026-07-10"), paidDate: null }],
      5,
    );
    expect(r).toEqual({ dueCount: 1, onTimeCount: 0, ratePct: 0 });
  });

  it("rounds the rate to 1 decimal place", () => {
    // 2 of 3 on time → 66.66… → 66.7
    const r = onTimeCollectionRate(
      [
        { dueDate: d("2026-07-10"), paidDate: d("2026-07-10") },
        { dueDate: d("2026-07-10"), paidDate: d("2026-07-11") },
        { dueDate: d("2026-07-10"), paidDate: null },
      ],
      5,
    );
    expect(r).toEqual({ dueCount: 3, onTimeCount: 2, ratePct: 66.7 });
  });
});

describe("onTimeBonusTier", () => {
  it("≥97 → full", () => {
    expect(onTimeBonusTier(100)).toBe("full");
    expect(onTimeBonusTier(97)).toBe("full");
  });
  it("≥92 and <97 → half", () => {
    expect(onTimeBonusTier(96.9)).toBe("half");
    expect(onTimeBonusTier(92)).toBe("half");
  });
  it("<92 → none", () => {
    expect(onTimeBonusTier(91.9)).toBe("none");
    expect(onTimeBonusTier(0)).toBe("none");
  });
  it("null → none", () => {
    expect(onTimeBonusTier(null)).toBe("none");
  });
});

describe("sumCents", () => {
  it("sums an integer-cents array", () => {
    expect(sumCents([100, 250, 0, 999])).toBe(1349);
    expect(sumCents([])).toBe(0);
  });
  it("throws on a non-integer amount (data-bug discipline)", () => {
    expect(() => sumCents([100, 12.5])).toThrow(/integer/);
    expect(() => sumCents([Number.NaN])).toThrow(/integer/);
  });
});
