import { describe, expect, it } from "vitest";
import {
  DEFAULT_RATES_PER_SLOT_CENTS,
  chargeForSession,
  rateForSlot,
  slotsBetween,
  type RateOverride,
  type SessionInput,
} from "./billing";

// Helpers to keep the test bodies focused on the assertion, not on
// the ceremony of constructing dates. We deliberately use plain
// `Date` (not date-fns or similar) since the production code does
// the same — adding a date lib here would diverge from real usage.
const d = (iso: string) => new Date(iso);

describe("slotsBetween", () => {
  it("counts exact slot-aligned windows", () => {
    // 9:00 → 10:30 = 3 slots (9:00, 9:30, 10:00)
    expect(slotsBetween(d("2026-05-24T09:00:00Z"), d("2026-05-24T10:30:00Z"))).toBe(3);
  });

  it("counts a single slot", () => {
    expect(slotsBetween(d("2026-05-24T09:00:00Z"), d("2026-05-24T09:30:00Z"))).toBe(1);
  });

  it("counts a long session spanning hours", () => {
    // 9:00 → 14:30 = 11 slots
    expect(slotsBetween(d("2026-05-24T09:00:00Z"), d("2026-05-24T14:30:00Z"))).toBe(11);
  });

  it("rounds an off-boundary start DOWN to the prior slot", () => {
    // 9:14 → 10:00 = floor(9:14)=9:00, ceil(10:00)=10:00 → 2 slots
    expect(slotsBetween(d("2026-05-24T09:14:00Z"), d("2026-05-24T10:00:00Z"))).toBe(2);
  });

  it("rounds an off-boundary end UP to the next slot", () => {
    // 9:00 → 10:01 = floor(9:00)=9:00, ceil(10:01)=10:30 → 3 slots
    expect(slotsBetween(d("2026-05-24T09:00:00Z"), d("2026-05-24T10:01:00Z"))).toBe(3);
  });

  it("rounds both ends outward (customer-favorable)", () => {
    // 9:14 → 10:01 = floor 9:00, ceil 10:30 → 3 slots
    expect(slotsBetween(d("2026-05-24T09:14:00Z"), d("2026-05-24T10:01:00Z"))).toBe(3);
  });

  it("crosses midnight (overnight session — rare but supported)", () => {
    // 23:00 → 01:00 next day = 4 slots
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
    expect(rateForSlot("weight_room", coachId, [])).toBe(500);
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
});

describe("chargeForSession", () => {
  const baseSession: SessionInput = {
    coachId: "coach-1",
    resourceType: "cage",
    startAt: new Date("2026-05-24T09:00:00Z"),
    endAt: new Date("2026-05-24T10:30:00Z"),
  };

  it("computes total at default rate", () => {
    expect(chargeForSession(baseSession, [])).toEqual({
      slots: 3,
      ratePer30MinCents: 2200,
      totalCents: 6600,
    });
  });

  it("applies a matching override", () => {
    const overrides: RateOverride[] = [
      { coachId: "coach-1", resourceType: "cage", ratePer30MinCents: 1800 },
    ];
    expect(chargeForSession(baseSession, overrides)).toEqual({
      slots: 3,
      ratePer30MinCents: 1800,
      totalCents: 5400,
    });
  });

  it("computes weight_room total at $5/slot default", () => {
    const session: SessionInput = {
      ...baseSession,
      resourceType: "weight_room",
    };
    expect(chargeForSession(session, [])).toEqual({
      slots: 3,
      ratePer30MinCents: 500,
      totalCents: 1500,
    });
  });

  it("propagates the slot-boundary rounding from slotsBetween", () => {
    // 9:14 → 10:01 = 3 slots × $22 = $66
    const session: SessionInput = {
      ...baseSession,
      startAt: new Date("2026-05-24T09:14:00Z"),
      endAt: new Date("2026-05-24T10:01:00Z"),
    };
    expect(chargeForSession(session, []).totalCents).toBe(6600);
  });
});

describe("DEFAULT_RATES_PER_SLOT_CENTS", () => {
  // Surface the constant in a test so a future "let's round to the
  // nearest dollar" edit gets caught loudly. The numbers match
  // BRAINSTORM.md and Dad's 2026-05-23 answer.
  it("matches the agreed pricing", () => {
    expect(DEFAULT_RATES_PER_SLOT_CENTS).toEqual({
      cage: 2200,
      bullpen: 2200,
      weight_room: 500,
    });
  });
});
