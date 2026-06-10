import { describe, expect, it } from "vitest";

import {
  capUtilizationPct,
  daysInPeriod,
  leadTimeBucket,
  noShowRate,
  suppressBelowK,
  utilizationPct,
} from "./aggregate";

const d = (iso: string) => new Date(iso);

describe("leadTimeBucket", () => {
  it("same_day for negative/zero lead (booked at or after start)", () => {
    expect(leadTimeBucket(d("2026-06-01T10:00:00Z"), d("2026-06-01T09:00:00Z"))).toBe(
      "same_day",
    );
    expect(leadTimeBucket(d("2026-06-01T09:00:00Z"), d("2026-06-01T09:00:00Z"))).toBe(
      "same_day",
    );
  });
  it("same_day for <1 day lead", () => {
    expect(leadTimeBucket(d("2026-06-01T00:00:00Z"), d("2026-06-01T20:00:00Z"))).toBe(
      "same_day",
    );
  });
  it("1_3_days at the 1-day and 3-day edges", () => {
    expect(leadTimeBucket(d("2026-06-01T00:00:00Z"), d("2026-06-02T00:00:00Z"))).toBe(
      "1_3_days",
    );
    expect(leadTimeBucket(d("2026-06-01T00:00:00Z"), d("2026-06-04T00:00:00Z"))).toBe(
      "1_3_days",
    );
  });
  it("4_7_days bucket", () => {
    expect(leadTimeBucket(d("2026-06-01T00:00:00Z"), d("2026-06-05T00:00:00Z"))).toBe(
      "4_7_days",
    );
    expect(leadTimeBucket(d("2026-06-01T00:00:00Z"), d("2026-06-08T00:00:00Z"))).toBe(
      "4_7_days",
    );
  });
  it("over_7_days bucket", () => {
    expect(leadTimeBucket(d("2026-06-01T00:00:00Z"), d("2026-06-10T00:00:00Z"))).toBe(
      "over_7_days",
    );
  });
});

describe("noShowRate", () => {
  it("returns 0 when denom is 0", () => {
    expect(noShowRate(0, 0)).toBe(0);
  });
  it("computes a whole-percent rate", () => {
    expect(noShowRate(8, 2)).toBe(20);
    expect(noShowRate(3, 1)).toBe(25);
  });
  it("rounds", () => {
    expect(noShowRate(2, 1)).toBe(33);
  });
  it("100% when all no-show", () => {
    expect(noShowRate(0, 5)).toBe(100);
  });
});

describe("capUtilizationPct", () => {
  it("returns 0 when no caps set", () => {
    expect(capUtilizationPct(10, 0)).toBe(0);
  });
  it("computes enrolled / total cap", () => {
    expect(capUtilizationPct(15, 30)).toBe(50);
  });
  it("can exceed 100 when over-enrolled (not clamped)", () => {
    expect(capUtilizationPct(40, 30)).toBe(133);
  });
});

describe("utilizationPct", () => {
  it("returns 0 with no active resources", () => {
    expect(utilizationPct(1000, 0, 7)).toBe(0);
  });
  it("returns 0 for a zero-length period", () => {
    expect(utilizationPct(1000, 5, 0)).toBe(0);
  });
  it("computes booked / available over 8:00-22:00 (14h) window", () => {
    // 1 resource, 1 day, 14h = 840 available minutes; 420 booked → 50%.
    expect(utilizationPct(420, 1, 1)).toBe(50);
  });
  it("respects a custom open-minutes-per-day", () => {
    // 1 resource, 1 day, 60 open min, 30 booked → 50%.
    expect(utilizationPct(30, 1, 1, 60)).toBe(50);
  });
});

describe("daysInPeriod", () => {
  it("counts a 7-day week as 7", () => {
    expect(daysInPeriod(d("2026-06-01T00:00:00Z"), d("2026-06-08T00:00:00Z"))).toBe(
      7,
    );
  });
  it("returns 0 for a non-positive span", () => {
    expect(daysInPeriod(d("2026-06-08T00:00:00Z"), d("2026-06-01T00:00:00Z"))).toBe(
      0,
    );
  });
  it("ceils a partial day", () => {
    expect(daysInPeriod(d("2026-06-01T00:00:00Z"), d("2026-06-01T01:00:00Z"))).toBe(
      1,
    );
  });
});

describe("suppressBelowK", () => {
  it("drops rows whose count < k, keeps >= k", () => {
    const rows = [
      { id: "a", n: 4 },
      { id: "b", n: 5 },
      { id: "c", n: 10 },
    ];
    const kept = suppressBelowK(rows, (r) => r.n, 5);
    expect(kept.map((r) => r.id)).toEqual(["b", "c"]);
  });
  it("returns empty when all below k (re-identification guard)", () => {
    const rows = [{ n: 1 }, { n: 2 }];
    expect(suppressBelowK(rows, (r) => r.n, 5)).toEqual([]);
  });
});
