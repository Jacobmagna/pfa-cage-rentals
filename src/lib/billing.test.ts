import { describe, expect, it } from "vitest";
import {
  DEFAULT_RATES_PER_SLOT_CENTS,
  computeRate,
  programMinutes,
  programPayFromSnapshot,
  rateForProgram,
  rateForSlot,
  slotsBetween,
  totalFromSnapshot,
  workPayForLog,
  type ProgramRateOverride,
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

describe("rateForProgram", () => {
  const coachId = "coach-1";
  const programId = "program-1";

  it("returns the program default when no override matches", () => {
    expect(rateForProgram(programId, coachId, [], 1500)).toBe(1500);
  });

  it("applies an override when (coachId, programId) matches", () => {
    const overrides: ProgramRateOverride[] = [
      { coachId, programId, ratePer30MinCents: 1800 },
    ];
    expect(rateForProgram(programId, coachId, overrides, 1500)).toBe(1800);
  });

  it("override wins even when the program default is null", () => {
    const overrides: ProgramRateOverride[] = [
      { coachId, programId, ratePer30MinCents: 1800 },
    ];
    expect(rateForProgram(programId, coachId, overrides, null)).toBe(1800);
  });

  it("ignores an override for a different coach", () => {
    const overrides: ProgramRateOverride[] = [
      { coachId: "other-coach", programId, ratePer30MinCents: 1800 },
    ];
    expect(rateForProgram(programId, coachId, overrides, 1500)).toBe(1500);
  });

  it("ignores an override for a different program", () => {
    const overrides: ProgramRateOverride[] = [
      { coachId, programId: "other-program", ratePer30MinCents: 1800 },
    ];
    expect(rateForProgram(programId, coachId, overrides, 1500)).toBe(1500);
  });

  it("returns null when neither override nor program default is set", () => {
    expect(rateForProgram(programId, coachId, [], null)).toBeNull();
  });

  it("falls back to the program default when an override targets a different program", () => {
    const overrides: ProgramRateOverride[] = [
      { coachId, programId: "other-program", ratePer30MinCents: 1800 },
    ];
    expect(rateForProgram(programId, coachId, overrides, null)).toBeNull();
  });

  it("picks the first matching override (linear scan)", () => {
    const overrides: ProgramRateOverride[] = [
      { coachId, programId, ratePer30MinCents: 1800 },
      { coachId, programId, ratePer30MinCents: 1500 },
    ];
    expect(rateForProgram(programId, coachId, overrides, 900)).toBe(1800);
  });
});

describe("computeRate", () => {
  const coachId = "coach-1";

  it("returns the per-coach override when one matches", () => {
    const overrides: RateOverride[] = [
      { coachId, resourceType: "cage", ratePer30MinCents: 1700 },
    ];
    expect(
      computeRate({
        coachId,
        resourceType: "cage",
        overrides,
      }),
    ).toBe(1700);
  });

  it("falls back to default when no override matches", () => {
    expect(
      computeRate({
        coachId,
        resourceType: "weight_room",
        overrides: [],
      }),
    ).toBe(700);
  });

  it("uses caller-supplied defaults map", () => {
    expect(
      computeRate({
        coachId,
        resourceType: "cage",
        overrides: [],
        defaults: { cage: 2400, bullpen: 2400, weight_room: 800 },
      }),
    ).toBe(2400);
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

  it("returns 0 when the snapshot rate is 0", () => {
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

describe("programMinutes", () => {
  it("returns exact minutes for a 30-min block", () => {
    expect(programMinutes(d("2026-05-24T09:00:00Z"), d("2026-05-24T09:30:00Z"))).toBe(30);
  });

  it("returns exact minutes for a 45-min block (15-min granular)", () => {
    expect(programMinutes(d("2026-05-24T09:00:00Z"), d("2026-05-24T09:45:00Z"))).toBe(45);
  });

  it("returns exact minutes for a 90-min block", () => {
    expect(programMinutes(d("2026-05-24T09:00:00Z"), d("2026-05-24T10:30:00Z"))).toBe(90);
  });

  it("returns exact minutes for a 15-min block", () => {
    expect(programMinutes(d("2026-05-24T09:00:00Z"), d("2026-05-24T09:15:00Z"))).toBe(15);
  });

  it("absorbs sub-minute drift with Math.round", () => {
    expect(programMinutes(d("2026-05-24T09:00:00Z"), d("2026-05-24T09:30:20Z"))).toBe(30);
  });

  it("throws when endAt equals startAt", () => {
    expect(() =>
      programMinutes(d("2026-05-24T09:00:00Z"), d("2026-05-24T09:00:00Z")),
    ).toThrow(/after/);
  });

  it("throws when endAt is before startAt", () => {
    expect(() =>
      programMinutes(d("2026-05-24T10:00:00Z"), d("2026-05-24T09:00:00Z")),
    ).toThrow(/after/);
  });
});

describe("programPayFromSnapshot", () => {
  // Historical guarantee: 30-min-aligned blocks bill identically to the
  // old slotsBetween × rate model, so past pay is unchanged.
  it("matches the old slot model for a 60-min block (2 slots)", () => {
    const start = d("2026-05-24T09:00:00Z");
    const end = d("2026-05-24T10:00:00Z");
    expect(programPayFromSnapshot(start, end, 2200)).toBe(4400);
    expect(programPayFromSnapshot(start, end, 2200)).toBe(
      totalFromSnapshot(start, end, 2200),
    );
  });

  it("matches the old slot model for a 30-min block (1 slot)", () => {
    const start = d("2026-05-24T09:00:00Z");
    const end = d("2026-05-24T09:30:00Z");
    expect(programPayFromSnapshot(start, end, 2200)).toBe(2200);
    expect(programPayFromSnapshot(start, end, 2200)).toBe(
      totalFromSnapshot(start, end, 2200),
    );
  });

  it("bills a 45-min block at 0.75× the hourly rate", () => {
    expect(
      programPayFromSnapshot(
        d("2026-05-24T09:00:00Z"),
        d("2026-05-24T09:45:00Z"),
        2200,
      ),
    ).toBe(3300);
  });

  it("bills a 15-min block at 0.25× the hourly rate", () => {
    expect(
      programPayFromSnapshot(
        d("2026-05-24T09:00:00Z"),
        d("2026-05-24T09:15:00Z"),
        2200,
      ),
    ).toBe(1100);
  });

  it("bills a 75-min block at 1.25× the hourly rate", () => {
    expect(
      programPayFromSnapshot(
        d("2026-05-24T09:00:00Z"),
        d("2026-05-24T10:15:00Z"),
        2200,
      ),
    ).toBe(5500);
  });

  it("rounds odd-cent rates to the nearest cent", () => {
    // 2151 per 30 min × 15 min / 30 = 1075.5 → round → 1076.
    expect(
      programPayFromSnapshot(
        d("2026-05-24T09:00:00Z"),
        d("2026-05-24T09:15:00Z"),
        2151,
      ),
    ).toBe(1076);
  });

  it("treats a null snapshot rate as $0", () => {
    expect(
      programPayFromSnapshot(
        d("2026-05-24T09:00:00Z"),
        d("2026-05-24T09:45:00Z"),
        null,
      ),
    ).toBe(0);
  });

  it("returns 0 when the snapshot rate is 0", () => {
    expect(
      programPayFromSnapshot(
        d("2026-05-24T09:00:00Z"),
        d("2026-05-24T09:45:00Z"),
        0,
      ),
    ).toBe(0);
  });

  it("throws when endAt is not after startAt", () => {
    expect(() =>
      programPayFromSnapshot(
        d("2026-05-24T09:00:00Z"),
        d("2026-05-24T09:00:00Z"),
        2200,
      ),
    ).toThrow(/after/);
  });
});

describe("workPayForLog", () => {
  // Per-session branch: a non-null perSessionRateCents pays a FLAT amount,
  // independent of duration and the hourly rate.
  it("returns the flat per-session amount when perSessionRateCents is set", () => {
    expect(
      workPayForLog({
        perSessionRateCents: 5000,
        startAt: d("2026-05-24T09:00:00Z"),
        endAt: d("2026-05-24T10:30:00Z"), // 90 min — irrelevant to pay
        ratePer30MinCents: 2200, // hourly basis — ignored when per-session
      }),
    ).toBe(5000);
  });

  it("ignores duration entirely in the per-session branch", () => {
    const short = workPayForLog({
      perSessionRateCents: 5000,
      startAt: d("2026-05-24T09:00:00Z"),
      endAt: d("2026-05-24T09:15:00Z"), // 15 min
      ratePer30MinCents: 2200,
    });
    const long = workPayForLog({
      perSessionRateCents: 5000,
      startAt: d("2026-05-24T09:00:00Z"),
      endAt: d("2026-05-24T12:00:00Z"), // 3 hr
      ratePer30MinCents: 2200,
    });
    expect(short).toBe(5000);
    expect(long).toBe(5000);
  });

  it("pays a per-session log of 0 cents as 0 (flat zero is honored)", () => {
    expect(
      workPayForLog({
        perSessionRateCents: 0,
        startAt: d("2026-05-24T09:00:00Z"),
        endAt: d("2026-05-24T10:00:00Z"),
        ratePer30MinCents: 2200,
      }),
    ).toBe(0);
  });

  // Hourly branch: null perSessionRateCents falls back to the per-30-min
  // snapshot via programPayFromSnapshot.
  it("falls back to the hourly snapshot when perSessionRateCents is null", () => {
    const start = d("2026-05-24T09:00:00Z");
    const end = d("2026-05-24T10:00:00Z"); // 60 min
    expect(
      workPayForLog({
        perSessionRateCents: null,
        startAt: start,
        endAt: end,
        ratePer30MinCents: 2200,
      }),
    ).toBe(programPayFromSnapshot(start, end, 2200));
  });

  it("bills a 45-min hourly log at 0.75× the hourly rate", () => {
    expect(
      workPayForLog({
        perSessionRateCents: null,
        startAt: d("2026-05-24T09:00:00Z"),
        endAt: d("2026-05-24T09:45:00Z"),
        ratePer30MinCents: 2200,
      }),
    ).toBe(3300);
  });

  it("treats a null hourly snapshot as $0 in the hourly branch", () => {
    expect(
      workPayForLog({
        perSessionRateCents: null,
        startAt: d("2026-05-24T09:00:00Z"),
        endAt: d("2026-05-24T10:00:00Z"),
        ratePer30MinCents: null,
      }),
    ).toBe(0);
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
