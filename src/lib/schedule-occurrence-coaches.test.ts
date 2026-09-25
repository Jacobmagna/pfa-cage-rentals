import { describe, expect, it } from "vitest";
import {
  planOccurrenceCoaches,
  sameCoachSet,
} from "@/lib/schedule-occurrence-coaches";
import { parsePfaInput } from "@/lib/timezone";

// Real PFA-local instants, built the way the app builds them, so the
// date-keying under test is exercised against the same conversion the
// generator and the block rows use. 2026-10-03 is a Saturday.
const at = (date: string, time = "09:00") => parsePfaInput(date, time);

const JORGE = "coach_jorge";
const JT = "coach_jt";
const MIKE = "coach_mike";
const SPENCER = "coach_spencer";

describe("sameCoachSet", () => {
  it("is order-independent", () => {
    expect(sameCoachSet([JORGE, JT], [JT, JORGE])).toBe(true);
  });

  it("treats two empty sets as equal", () => {
    expect(sameCoachSet([], [])).toBe(true);
  });

  it("separates an empty set from a populated one", () => {
    expect(sameCoachSet([], [JORGE])).toBe(false);
    expect(sameCoachSet([JORGE], [])).toBe(false);
  });

  it("ignores duplicates rather than counting them", () => {
    expect(sameCoachSet([JORGE, JORGE], [JORGE])).toBe(true);
  });

  // The case a length-check-plus-includes implementation gets confidently
  // wrong: equal lengths, and every member of the first IS in the second.
  it("does not confuse a duplicated member for a different one", () => {
    expect(sameCoachSet([JORGE, JORGE], [JORGE, JT])).toBe(false);
  });

  it("separates disjoint sets of equal size", () => {
    expect(sameCoachSet([JORGE], [JT])).toBe(false);
  });
});

describe("planOccurrenceCoaches", () => {
  // ── THE REPORTED DEFECT ────────────────────────────────────────────────
  // Series says Jorge. One Saturday was hand-changed to JT. The series is
  // now edited (to Mike). JT must survive; the untouched dates must move.
  it("keeps a hand-assigned coach and moves every other date", () => {
    const plan = planOccurrenceCoaches({
      occurrences: [
        { startAt: at("2026-10-03") },
        { startAt: at("2026-10-10") },
        { startAt: at("2026-10-17") },
      ],
      existing: [
        { startAt: at("2026-10-03"), coachIds: [JORGE] },
        { startAt: at("2026-10-10"), coachIds: [JT] },
        { startAt: at("2026-10-17"), coachIds: [JORGE] },
      ],
      previousSeriesCoachIds: [JORGE],
      nextSeriesCoachIds: [MIKE],
      applyCoachesToAll: false,
    });

    expect(plan.assignments.map((a) => a.coachIds)).toEqual([
      [MIKE],
      [JT],
      [MIKE],
    ]);
    expect(plan.assignments.map((a) => a.preserved)).toEqual([
      false,
      true,
      false,
    ]);
    expect(plan.preservedCount).toBe(1);
    expect(plan.preservedDates).toEqual(["2026-10-10"]);
  });

  it("preserves nothing when no date was ever individually changed", () => {
    const plan = planOccurrenceCoaches({
      occurrences: [{ startAt: at("2026-10-03") }, { startAt: at("2026-10-10") }],
      existing: [
        { startAt: at("2026-10-03"), coachIds: [JORGE] },
        { startAt: at("2026-10-10"), coachIds: [JORGE] },
      ],
      previousSeriesCoachIds: [JORGE],
      nextSeriesCoachIds: [MIKE],
      applyCoachesToAll: false,
    });

    expect(plan.assignments.every((a) => a.coachIds[0] === MIKE)).toBe(true);
    expect(plan.preservedCount).toBe(0);
    expect(plan.preservedDates).toEqual([]);
  });

  // The escape hatch. Same inputs as the reported-defect case, one flag
  // flipped — and the flag must be the ONLY difference in outcome.
  it("overwrites even hand-assigned dates when told to apply to all", () => {
    const plan = planOccurrenceCoaches({
      occurrences: [
        { startAt: at("2026-10-03") },
        { startAt: at("2026-10-10") },
      ],
      existing: [
        { startAt: at("2026-10-03"), coachIds: [JORGE] },
        { startAt: at("2026-10-10"), coachIds: [JT] },
      ],
      previousSeriesCoachIds: [JORGE],
      nextSeriesCoachIds: [MIKE],
      applyCoachesToAll: true,
    });

    expect(plan.assignments.map((a) => a.coachIds)).toEqual([[MIKE], [MIKE]]);
    expect(plan.preservedCount).toBe(0);
  });

  // 🔴 The whole reason the match is by calendar date. A series edit that
  // also moves the window changes every occurrence's instant; matching on
  // the instant preserves nothing, and does it silently.
  it("still matches a date whose time-of-day moved with the series", () => {
    const plan = planOccurrenceCoaches({
      // The new definition runs 08:00 instead of 09:00.
      occurrences: [{ startAt: at("2026-10-10", "08:00") }],
      existing: [{ startAt: at("2026-10-10", "09:00"), coachIds: [JT] }],
      previousSeriesCoachIds: [JORGE],
      nextSeriesCoachIds: [MIKE],
      applyCoachesToAll: false,
    });

    expect(plan.assignments[0]!.coachIds).toEqual([JT]);
    expect(plan.preservedCount).toBe(1);
  });

  it("preserves the primary coach's position, not just the membership", () => {
    const plan = planOccurrenceCoaches({
      occurrences: [{ startAt: at("2026-10-10") }],
      existing: [{ startAt: at("2026-10-10"), coachIds: [JT, SPENCER] }],
      previousSeriesCoachIds: [JORGE],
      nextSeriesCoachIds: [MIKE],
      applyCoachesToAll: false,
    });

    // JT first — a preserved set that silently re-ordered would change the
    // block's headline coach, which is most of what the tile shows.
    expect(plan.assignments[0]!.coachIds).toEqual([JT, SPENCER]);
  });

  // "I deliberately took everybody off this one date" is an individual
  // assignment too, and the empty set has to survive like any other.
  it("preserves a date that was deliberately cleared of coaches", () => {
    const plan = planOccurrenceCoaches({
      occurrences: [{ startAt: at("2026-10-10") }],
      existing: [{ startAt: at("2026-10-10"), coachIds: [] }],
      previousSeriesCoachIds: [JORGE],
      nextSeriesCoachIds: [MIKE],
      applyCoachesToAll: false,
    });

    expect(plan.assignments[0]!.coachIds).toEqual([]);
    expect(plan.assignments[0]!.preserved).toBe(true);
  });

  // A coachless series is the QA-R2 #10 case. Every occurrence matches the
  // previous (empty) set, so nothing is an exception and everything moves.
  it("moves every date when the series had no coaches at all", () => {
    const plan = planOccurrenceCoaches({
      occurrences: [{ startAt: at("2026-10-10") }],
      existing: [{ startAt: at("2026-10-10"), coachIds: [] }],
      previousSeriesCoachIds: [],
      nextSeriesCoachIds: [MIKE],
      applyCoachesToAll: false,
    });

    expect(plan.assignments[0]!.coachIds).toEqual([MIKE]);
    expect(plan.assignments[0]!.preserved).toBe(false);
  });

  it("treats a re-ordered but identical set as untouched", () => {
    const plan = planOccurrenceCoaches({
      occurrences: [{ startAt: at("2026-10-10") }],
      existing: [{ startAt: at("2026-10-10"), coachIds: [SPENCER, JORGE] }],
      previousSeriesCoachIds: [JORGE, SPENCER],
      nextSeriesCoachIds: [MIKE],
      applyCoachesToAll: false,
    });

    expect(plan.assignments[0]!.coachIds).toEqual([MIKE]);
    expect(plan.preservedCount).toBe(0);
  });

  // A date the series newly generates (the season was extended, or a
  // weekday added) has no existing block, so there is nothing to preserve.
  it("assigns the new set to a date that did not exist before", () => {
    const plan = planOccurrenceCoaches({
      occurrences: [{ startAt: at("2026-10-10") }, { startAt: at("2026-10-17") }],
      existing: [{ startAt: at("2026-10-10"), coachIds: [JT] }],
      previousSeriesCoachIds: [JORGE],
      nextSeriesCoachIds: [MIKE],
      applyCoachesToAll: false,
    });

    expect(plan.assignments.map((a) => a.coachIds)).toEqual([[JT], [MIKE]]);
    expect(plan.preservedDates).toEqual(["2026-10-10"]);
  });

  it("returns preserved dates ascending regardless of occurrence order", () => {
    const plan = planOccurrenceCoaches({
      occurrences: [
        { startAt: at("2026-10-17") },
        { startAt: at("2026-10-03") },
      ],
      existing: [
        { startAt: at("2026-10-17"), coachIds: [JT] },
        { startAt: at("2026-10-03"), coachIds: [SPENCER] },
      ],
      previousSeriesCoachIds: [JORGE],
      nextSeriesCoachIds: [MIKE],
      applyCoachesToAll: false,
    });

    expect(plan.preservedDates).toEqual(["2026-10-03", "2026-10-17"]);
  });

  it("does not mutate the caller's arrays", () => {
    const next = [MIKE];
    const existingCoaches = [JT];
    const plan = planOccurrenceCoaches({
      occurrences: [{ startAt: at("2026-10-10") }, { startAt: at("2026-10-17") }],
      existing: [{ startAt: at("2026-10-10"), coachIds: existingCoaches }],
      previousSeriesCoachIds: [JORGE],
      nextSeriesCoachIds: next,
      applyCoachesToAll: false,
    });

    plan.assignments[0]!.coachIds.push("intruder");
    expect(next).toEqual([MIKE]);
    expect(existingCoaches).toEqual([JT]);
  });
});
