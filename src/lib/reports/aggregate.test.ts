// Unit tests for the report aggregator. Pure module → no mocks
// needed. Stage E3 expands this with edge cases; the starter tests
// here ride along with E1 to keep the pure module honest as the
// page + Excel layers build on top.

import { describe, expect, it } from "vitest";
import {
  aggregateReport,
  type AggregateSessionInput,
} from "./aggregate";
import type { RateOverride } from "@/lib/billing";

// Build a session input with sensible defaults; tests override only
// the fields they care about.
function session(
  overrides: Partial<AggregateSessionInput> = {},
): AggregateSessionInput {
  // Construct dates as explicit UTC so display assertions are
  // independent of the test runner's local TZ. 2026-05-01 is in EDT
  // (UTC-4), so 13:00 UTC → "09:00" PFA time, the value the original
  // test was asserting on.
  const startAt = new Date("2026-05-01T13:00:00Z");
  const endAt = new Date("2026-05-01T14:00:00Z"); // 1 hour = 2 slots
  return {
    sessionId: "s-1",
    coachId: "coach-a",
    coachName: "Coach A",
    coachEmail: "a@example.com",
    resourceId: "res-1",
    resourceName: "Cage 1",
    resourceType: "cage",
    startAt,
    endAt,
    useType: "hitting",
    note: null,
    isTeamRental: false,
    pfaReferred: false,
    ...overrides,
  };
}

describe("aggregateReport — detail rows", () => {
  it("computes slots, rate, and total per session using billing.ts defaults", () => {
    const { detail } = aggregateReport([session()], []);
    expect(detail).toHaveLength(1);
    const row = detail[0];
    expect(row.slots).toBe(2);
    expect(row.ratePerSlotCents).toBe(2200); // cage default
    expect(row.totalCents).toBe(4400);
    expect(row.rateSource).toBe("default");
    expect(row.date).toBe("2026-05-01");
    expect(row.startTime).toBe("09:00");
    expect(row.endTime).toBe("10:00");
    expect(row.durationMinutes).toBe(60);
  });

  it("falls back to coach email when name is null", () => {
    const { detail } = aggregateReport(
      [session({ coachName: null, coachEmail: "nameless@example.com" })],
      [],
    );
    expect(detail[0].coachName).toBe("nameless@example.com");
  });
});

describe("aggregateReport — rate overrides", () => {
  it("applies override and flags rateSource = override", () => {
    const overrides: RateOverride[] = [
      { coachId: "coach-a", resourceType: "cage", ratePer30MinCents: 1500 },
    ];
    const { detail, summary } = aggregateReport([session()], overrides);
    expect(detail[0].ratePerSlotCents).toBe(1500);
    expect(detail[0].totalCents).toBe(3000);
    expect(detail[0].rateSource).toBe("override");
    expect(summary[0].appliedOverride).toBe(true);
  });

  it("only applies the override that matches both coach and resource type", () => {
    const overrides: RateOverride[] = [
      // Different coach
      { coachId: "coach-b", resourceType: "cage", ratePer30MinCents: 1500 },
      // Same coach but different resource type
      { coachId: "coach-a", resourceType: "bullpen", ratePer30MinCents: 1500 },
    ];
    const { detail } = aggregateReport([session()], overrides);
    expect(detail[0].ratePerSlotCents).toBe(2200); // default, no match
    expect(detail[0].rateSource).toBe("default");
  });
});

describe("aggregateReport — summary roll-up", () => {
  it("aggregates per coach across all three resource types", () => {
    const sessions: AggregateSessionInput[] = [
      session({ sessionId: "s1", resourceType: "cage" }), // 4400
      session({
        sessionId: "s2",
        resourceType: "bullpen",
        resourceName: "Bullpen 1",
        useType: null,
      }), // 2 slots × 2200 = 4400
      session({
        sessionId: "s3",
        resourceType: "weight_room",
        resourceName: "Weight Room 1",
        useType: null,
      }), // 2 slots × 500 = 1000
    ];
    const { summary, grandTotalCents } = aggregateReport(sessions, []);
    expect(summary).toHaveLength(1);
    const row = summary[0];
    expect(row.cageSlots).toBe(2);
    expect(row.cageTotalCents).toBe(4400);
    expect(row.bullpenSlots).toBe(2);
    expect(row.bullpenTotalCents).toBe(4400);
    expect(row.weightRoomSlots).toBe(2);
    expect(row.weightRoomTotalCents).toBe(1000);
    expect(row.totalCents).toBe(9800);
    expect(row.appliedOverride).toBe(false);
    expect(grandTotalCents).toBe(9800);
  });

  it("sorts summary by coach name and creates a row per coach", () => {
    const sessions: AggregateSessionInput[] = [
      session({ coachId: "c-z", coachName: "Zoe", coachEmail: "z@x.com" }),
      session({ coachId: "c-a", coachName: "Alice", coachEmail: "a@x.com" }),
      session({ coachId: "c-m", coachName: "Mike", coachEmail: "m@x.com" }),
    ];
    const { summary } = aggregateReport(sessions, []);
    expect(summary.map((s) => s.coachName)).toEqual(["Alice", "Mike", "Zoe"]);
  });

  it("returns empty arrays + zero grand total for no sessions", () => {
    const { detail, summary, grandTotalCents } = aggregateReport([], []);
    expect(detail).toEqual([]);
    expect(summary).toEqual([]);
    expect(grandTotalCents).toBe(0);
  });
});
