// Unit tests for classifyManualLog (1b security B — held-then-approve).
// Pure module → no DB, no mocks: fixed Dates + a deterministic stub
// formatTime that prints UTC "HH:MM" so the asserted messages are stable
// regardless of the runner's TZ. Mirrors reconciliation.test.ts.
//
// Covers each verdict: clean (on-time within ±15), unscheduled (no member
// block overlaps), wrong_time (overlap but >15 off on an end), over_logged
// (overlap, logged > scheduled by > 30 min), and the "no member blocks"
// case (empty blocks ⇒ unscheduled).

import { describe, expect, it } from "vitest";
import { classifyManualLog, type ReconBlock } from "./reconciliation";

// UTC "HH:MM" stub — deterministic, TZ-independent.
const fmt = (d: Date) => d.toISOString().slice(11, 16);

const at = (iso: string) => new Date(iso);

// A scheduled block the coach c1 is a member of: program p1, 14:00–15:00 UTC.
function block(over: Partial<ReconBlock> = {}): ReconBlock {
  const base = {
    id: "b1",
    programId: "p1",
    scheduledCoachId: "c1",
    scheduledCoachName: "",
    startAt: at("2026-06-01T14:00:00Z"),
    endAt: at("2026-06-01T15:00:00Z"),
    ...over,
  };
  return {
    ...base,
    coaches: over.coaches ?? [{ coachId: base.scheduledCoachId, coachName: "" }],
  };
}

const log = (over: Partial<{
  coachId: string;
  programId: string;
  startAt: Date;
  endAt: Date;
}> = {}) => ({
  coachId: "c1",
  programId: "p1",
  startAt: at("2026-06-01T14:00:00Z"),
  endAt: at("2026-06-01T15:00:00Z"),
  ...over,
});

describe("classifyManualLog", () => {
  it("clean: exact match within tolerance", () => {
    expect(classifyManualLog(log(), [block()], fmt)).toEqual({ kind: "clean" });
  });

  it("clean: both ends within ±15 min", () => {
    const v = classifyManualLog(
      log({
        startAt: at("2026-06-01T14:10:00Z"),
        endAt: at("2026-06-01T14:50:00Z"),
      }),
      [block()],
      fmt,
    );
    expect(v).toEqual({ kind: "clean" });
  });

  it("unscheduled: no overlapping same-program block", () => {
    // Log is at 20:00 — no block overlaps it.
    const v = classifyManualLog(
      log({
        startAt: at("2026-06-01T20:00:00Z"),
        endAt: at("2026-06-01T21:00:00Z"),
      }),
      [block()],
      fmt,
    );
    expect(v).toEqual({
      kind: "unscheduled",
      message: "This time isn't on your work schedule.",
    });
  });

  it("unscheduled: no member blocks at all (empty list)", () => {
    const v = classifyManualLog(log(), [], fmt);
    expect(v).toEqual({
      kind: "unscheduled",
      message: "This time isn't on your work schedule.",
    });
  });

  it("wrong_time: overlaps a block but >15 min off on an end", () => {
    // Same start, ends 30 min early → end is off by 30 (>15), under-logged
    // (shorter, not over) so it's wrong_time not over_logged.
    const v = classifyManualLog(
      log({ endAt: at("2026-06-01T14:30:00Z") }),
      [block()],
      fmt,
    );
    expect(v).toEqual({
      kind: "wrong_time",
      message: "That doesn't match your scheduled block (14:00–15:00).",
    });
  });

  it("over_logged: overlaps, logged > 30 min longer than scheduled", () => {
    // Same start, ends 14:00–16:00 (2h) vs scheduled 1h → 60 min over (>30).
    const v = classifyManualLog(
      log({ endAt: at("2026-06-01T16:00:00Z") }),
      [block()],
      fmt,
    );
    expect(v).toEqual({
      kind: "over_logged",
      message:
        "You logged longer than the scheduled block (14:00–15:00).",
    });
  });
});
