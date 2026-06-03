// Unit tests for the report aggregator. Pure module → no mocks
// needed. Reads the snapshotted ratePer30MinCents from each input
// row (no more recompute-from-overrides path).

import { describe, expect, it } from "vitest";
import {
  aggregateReport,
  type AggregateHourLogInput,
  type AggregateSessionInput,
} from "./aggregate";

// Build a session input with sensible defaults; tests override only
// the fields they care about.
function session(
  overrides: Partial<AggregateSessionInput> = {},
): AggregateSessionInput {
  // Construct dates as explicit UTC so display assertions are
  // independent of the test runner's local TZ. 2026-05-01 is in EDT
  // (UTC-4), so 13:00 UTC → "09:00" PFA time.
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
    isOnline: false,
    ratePer30MinCents: 2200,
    ...overrides,
  };
}

describe("aggregateReport — detail rows", () => {
  it("computes slots and total from the snapshotted rate", () => {
    const { detail } = aggregateReport([session()]);
    expect(detail).toHaveLength(1);
    const row = detail[0];
    expect(row.slots).toBe(2);
    expect(row.ratePerSlotCents).toBe(2200);
    expect(row.totalCents).toBe(4400);
    expect(row.date).toBe("2026-05-01");
    expect(row.startTime).toBe("09:00");
    expect(row.endTime).toBe("10:00");
    expect(row.durationMinutes).toBe(60);
  });

  it("falls back to coach email when name is null", () => {
    const { detail } = aggregateReport([
      session({ coachName: null, coachEmail: "nameless@example.com" }),
    ]);
    expect(detail[0].coachName).toBe("nameless@example.com");
  });

  it("uses the discounted snapshot rate exactly as stored", () => {
    const { detail, summary } = aggregateReport([
      session({ ratePer30MinCents: 1500 }),
    ]);
    expect(detail[0].ratePerSlotCents).toBe(1500);
    expect(detail[0].totalCents).toBe(3000);
    expect(summary[0].totalCents).toBe(3000);
  });

  it("treats online sessions as $0 even with slots > 0", () => {
    const { detail, summary } = aggregateReport([
      session({ isOnline: true, ratePer30MinCents: 0 }),
    ]);
    expect(detail[0].isOnline).toBe(true);
    expect(detail[0].totalCents).toBe(0);
    expect(summary[0].onlineSessions).toBe(1);
    expect(summary[0].totalCents).toBe(0);
  });
});

describe("aggregateReport — summary roll-up", () => {
  it("aggregates per coach across all three resource types", () => {
    const sessions: AggregateSessionInput[] = [
      session({ sessionId: "s1", resourceType: "cage" }), // 2 × 2200 = 4400
      session({
        sessionId: "s2",
        resourceType: "bullpen",
        resourceName: "Bullpen 1",
        useType: null,
      }), // 2 × 2200 = 4400
      session({
        sessionId: "s3",
        resourceType: "weight_room",
        resourceName: "Weight Room 1",
        useType: null,
        ratePer30MinCents: 700,
      }), // 2 × 700 = 1400
    ];
    const { summary, grandTotalCents } = aggregateReport(sessions);
    expect(summary).toHaveLength(1);
    const row = summary[0];
    expect(row.cageSlots).toBe(2);
    expect(row.cageTotalCents).toBe(4400);
    expect(row.bullpenSlots).toBe(2);
    expect(row.bullpenTotalCents).toBe(4400);
    expect(row.weightRoomSlots).toBe(2);
    expect(row.weightRoomTotalCents).toBe(1400);
    expect(row.totalCents).toBe(10200);
    expect(row.onlineSessions).toBe(0);
    expect(grandTotalCents).toBe(10200);
  });

  it("sorts summary by coach name and creates a row per coach", () => {
    const sessions: AggregateSessionInput[] = [
      session({ coachId: "c-z", coachName: "Zoe", coachEmail: "z@x.com" }),
      session({ coachId: "c-a", coachName: "Alice", coachEmail: "a@x.com" }),
      session({ coachId: "c-m", coachName: "Mike", coachEmail: "m@x.com" }),
    ];
    const { summary } = aggregateReport(sessions);
    expect(summary.map((s) => s.coachName)).toEqual(["Alice", "Mike", "Zoe"]);
  });

  it("returns empty arrays + zero grand total for no sessions", () => {
    const { detail, summary, grandTotalCents } = aggregateReport([]);
    expect(detail).toEqual([]);
    expect(summary).toEqual([]);
    expect(grandTotalCents).toBe(0);
  });

  it("defaults program fields to 0 when no hour logs are passed", () => {
    const { summary } = aggregateReport([session()]);
    expect(summary[0].programSlots).toBe(0);
    expect(summary[0].programTotalCents).toBe(0);
  });
});

// Build a program-hour log input; same UTC date convention as session().
function hourLog(
  overrides: Partial<AggregateHourLogInput> = {},
): AggregateHourLogInput {
  return {
    coachId: "coach-a",
    coachName: "Coach A",
    coachEmail: "a@example.com",
    startAt: new Date("2026-05-01T13:00:00Z"),
    endAt: new Date("2026-05-01T14:00:00Z"), // 1 hour = 2 slots
    ratePer30MinCents: 1500,
    ...overrides,
  };
}

describe("aggregateReport — program hours", () => {
  it("rolls hour logs into a program category and the coach total", () => {
    const { summary, grandTotalCents } = aggregateReport(
      [session()], // cage: 2 × 2200 = 4400
      [hourLog()], // program: 2 × 1500 = 3000
    );
    expect(summary).toHaveLength(1);
    const row = summary[0];
    expect(row.cageTotalCents).toBe(4400);
    expect(row.programSlots).toBe(2);
    expect(row.programTotalCents).toBe(3000);
    expect(row.totalCents).toBe(7400);
    expect(grandTotalCents).toBe(7400);
  });

  it("creates a summary row for a coach with only program hours (no detail)", () => {
    const { detail, summary } = aggregateReport(
      [],
      [hourLog({ coachId: "c-prog", coachName: "Prog Only" })],
    );
    expect(detail).toEqual([]);
    expect(summary).toHaveLength(1);
    expect(summary[0].coachName).toBe("Prog Only");
    expect(summary[0].programTotalCents).toBe(3000);
    expect(summary[0].cageTotalCents).toBe(0);
    expect(summary[0].totalCents).toBe(3000);
  });

  it("treats a null/zero snapshot rate as $0 program pay", () => {
    const { summary } = aggregateReport(
      [],
      [hourLog({ ratePer30MinCents: 0 })],
    );
    expect(summary[0].programSlots).toBe(2);
    expect(summary[0].programTotalCents).toBe(0);
    expect(summary[0].totalCents).toBe(0);
  });

  it("falls back to coach email when the hour-log coach name is null", () => {
    const { summary } = aggregateReport(
      [],
      [hourLog({ coachName: null, coachEmail: "noname@example.com" })],
    );
    expect(summary[0].coachName).toBe("noname@example.com");
  });
});
