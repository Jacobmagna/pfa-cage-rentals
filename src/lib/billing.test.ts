import { describe, expect, it } from "vitest";
import {
  DEFAULT_RATES_PER_SLOT_CENTS,
  computeRate,
  rateForSlot,
  slotsBetween,
  totalFromSnapshot,
  type RateOverride,
  type ResourceType,
} from "./billing";

// Helpers to keep the test bodies focused on the assertion, not on
// the ceremony of constructing dates. We deliberately use plain
// `Date` (not date-fns or similar) since the production code does
// the same — adding a date lib here would diverge from real usage.
const d = (iso: string) => new Date(iso);

describe("slotsBetween", () => {
  it("counts exact slot-aligned windows", () => {
    expect(slotsBetween(d("2026-05-24T09:00:00Z"), d("2026-05-24T10:30:00Z"))).toBe(3);
  });

  it("counts a single slot", () => {
    expect(slotsBetween(d("2026-05-24T09:00:00Z"), d("2026-05-24T09:30:00Z"))).toBe(1);
  });

  it("counts a long session spanning hours", () => {
    expect(slotsBetween(d("2026-05-24T09:00:00Z"), d("2026-05-24T14:30:00Z"))).toBe(11);
  });

  it("rounds an off-boundary start DOWN to the prior slot", () => {
    expect(slotsBetween(d("2026-05-24T09:14:00Z"), d("2026-05-24T10:00:00Z"))).toBe(2);
  });

  it("rounds an off-boundary end UP to the next slot", () => {
    expect(slotsBetween(d("2026-05-24T09:00:00Z"), d("2026-05-24T10:01:00Z"))).toBe(3);
  });

  it("rounds both ends outward (customer-favorable)", () => {
    expect(slotsBetween(d("2026-05-24T09:14:00Z"), d("2026-05-24T10:01:00Z"))).toBe(3);
  });

  it("crosses midnight (overnight session — rare but supported)", () => {
    expect(
      slotsBetween(d("2026-05-24T23:00:00Z"), d("2026-05-25T01:00:00Z")),
    ).toBe(4);
  });

  it("throws when endAt equals startAt", () => {
    expect(() =>
      slotsBetween(d("2026-05-24T09:00:00Z"), d("2026-05-24T09:00:00Z")),
    ).toThrow(/strictly after/);
  });

  it("throws when endAt is before startAt", () => {
    expect(() =>
      slotsBetween(d("2026-05-24T10:00:00Z"), d("2026-05-24T09:00:00Z")),
    ).toThrow(/strictly after/);
  });
});

describe("rateForSlot", () => {
  const coachId = "coach-1";

  it("returns the default cage rate when no override matches", () => {
    expect(rateForSlot("cage", coachId, [])).toBe(2200);
  });

  it("returns the default bullpen rate when no override matches", () => {
    expect(rateForSlot("bullpen", coachId, [])).toBe(2200);
  });

  it("returns the default weight_room rate when no override matches", () => {
    expect(rateForSlot("weight_room", coachId, [])).toBe(700);
  });

  it("applies an override when (coachId, resourceType) matches", () => {
    const overrides: RateOverride[] = [
      { coachId, resourceType: "cage", ratePer30MinCents: 1800 },
    ];
    expect(rateForSlot("cage", coachId, overrides)).toBe(1800);
  });

  it("ignores an override for a different coach", () => {
    const overrides: RateOverride[] = [
      { coachId: "other-coach", resourceType: "cage", ratePer30MinCents: 1800 },
    ];
    expect(rateForSlot("cage", coachId, overrides)).toBe(2200);
  });

  it("ignores an override for a different resource type", () => {
    const overrides: RateOverride[] = [
      { coachId, resourceType: "bullpen", ratePer30MinCents: 1800 },
    ];
    expect(rateForSlot("cage", coachId, overrides)).toBe(2200);
  });

  it("picks the first matching override when multiple are present (linear scan)", () => {
    const overrides: RateOverride[] = [
      { coachId, resourceType: "cage", ratePer30MinCents: 1800 },
      { coachId, resourceType: "cage", ratePer30MinCents: 1500 },
    ];
    expect(rateForSlot("cage", coachId, overrides)).toBe(1800);
  });

  it("uses caller-supplied defaults when provided", () => {
    const customDefaults: Record<ResourceType, number> = {
      cage: 2400,
      bullpen: 2400,
      weight_room: 800,
    };
    expect(rateForSlot("cage", coachId, [], customDefaults)).toBe(2400);
  });
});

describe("computeRate", () => {
  const coachId = "coach-1";

  it("returns 0 for an online session regardless of overrides", () => {
    const overrides: RateOverride[] = [
      { coachId, resourceType: "cage", ratePer30MinCents: 1500 },
    ];
    expect(
      computeRate({
        coachId,
        resourceType: "cage",
        isOnline: true,
        overrides,
      }),
    ).toBe(0);
  });

  it("returns the per-coach override when not online", () => {
    const overrides: RateOverride[] = [
      { coachId, resourceType: "cage", ratePer30MinCents: 1700 },
    ];
    expect(
      computeRate({
        coachId,
        resourceType: "cage",
        isOnline: false,
        overrides,
      }),
    ).toBe(1700);
  });

  it("falls back to default when no override matches", () => {
    expect(
      computeRate({
        coachId,
        resourceType: "weight_room",
        isOnline: false,
        overrides: [],
      }),
    ).toBe(700);
  });

  it("uses caller-supplied defaults map", () => {
    expect(
      computeRate({
        coachId,
        resourceType: "cage",
        isOnline: false,
        overrides: [],
        defaults: { cage: 2400, bullpen: 2400, weight_room: 800 },
      }),
    ).toBe(2400);
  });

  it("online flag wins over both override and custom defaults", () => {
    const overrides: RateOverride[] = [
      { coachId, resourceType: "cage", ratePer30MinCents: 1700 },
    ];
    expect(
      computeRate({
        coachId,
        resourceType: "cage",
        isOnline: true,
        overrides,
        defaults: { cage: 9999, bullpen: 9999, weight_room: 9999 },
      }),
    ).toBe(0);
  });
});

describe("totalFromSnapshot", () => {
  it("multiplies snapshot rate by slot count", () => {
    expect(
      totalFromSnapshot(
        new Date("2026-05-24T09:00:00Z"),
        new Date("2026-05-24T10:30:00Z"),
        1700,
      ),
    ).toBe(5100);
  });

  it("returns 0 when the snapshot rate is 0 (online session)", () => {
    expect(
      totalFromSnapshot(
        new Date("2026-05-24T09:00:00Z"),
        new Date("2026-05-24T10:30:00Z"),
        0,
      ),
    ).toBe(0);
  });

  it("preserves the original rate even if a default has since drifted", () => {
    // Regression test for the snapshot guarantee: if rate_defaults
    // changes after a session is created, the historical session
    // must still report at its stamped rate.
    const historicalRate = 1700;
    expect(
      totalFromSnapshot(
        new Date("2026-05-24T09:00:00Z"),
        new Date("2026-05-24T10:30:00Z"),
        historicalRate,
      ),
    ).toBe(5100);
  });
});

describe("DEFAULT_RATES_PER_SLOT_CENTS", () => {
  // Surface the constant so a future "let's round to the nearest
  // dollar" edit gets caught loudly. Matches Dad's Excel + rate_defaults
  // seed values (verified 2026-05-25).
  it("matches the agreed pricing", () => {
    expect(DEFAULT_RATES_PER_SLOT_CENTS).toEqual({
      cage: 2200,
      bullpen: 2200,
      weight_room: 700,
    });
  });
});
