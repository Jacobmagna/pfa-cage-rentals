import { describe, expect, it } from "vitest";
import { findOverlappingLogIds } from "./hour-log-overlap";

// A fixed reference instant so the tests read in human time.
const T0 = Date.UTC(2026, 5, 6, 9, 0, 0); // 2026-06-06 09:00:00 UTC
const MIN = 60_000;
const at = (m: number) => T0 + m * MIN;

describe("findOverlappingLogIds", () => {
  it("returns empty when there is no overlap", () => {
    const result = findOverlappingLogIds([
      { id: "a", coachId: "c1", startMs: at(0), endMs: at(60) },
      { id: "b", coachId: "c1", startMs: at(120), endMs: at(180) },
    ]);
    expect(result.size).toBe(0);
  });

  it("does NOT flag logs that merely touch at an endpoint (half-open)", () => {
    const result = findOverlappingLogIds([
      { id: "a", coachId: "c1", startMs: at(0), endMs: at(60) },
      { id: "b", coachId: "c1", startMs: at(60), endMs: at(120) },
    ]);
    expect(result.size).toBe(0);
  });

  it("flags both logs on a partial overlap", () => {
    const result = findOverlappingLogIds([
      { id: "a", coachId: "c1", startMs: at(0), endMs: at(60) },
      { id: "b", coachId: "c1", startMs: at(45), endMs: at(120) },
    ]);
    expect(result).toEqual(new Set(["a", "b"]));
  });

  it("flags identical times", () => {
    const result = findOverlappingLogIds([
      { id: "a", coachId: "c1", startMs: at(0), endMs: at(60) },
      { id: "b", coachId: "c1", startMs: at(0), endMs: at(60) },
    ]);
    expect(result).toEqual(new Set(["a", "b"]));
  });

  it("does NOT flag same-time logs for different coaches", () => {
    const result = findOverlappingLogIds([
      { id: "a", coachId: "c1", startMs: at(0), endMs: at(60) },
      { id: "b", coachId: "c2", startMs: at(0), endMs: at(60) },
    ]);
    expect(result.size).toBe(0);
  });

  it("flags all three on a 3-way overlap for the same coach", () => {
    const result = findOverlappingLogIds([
      { id: "a", coachId: "c1", startMs: at(0), endMs: at(90) },
      { id: "b", coachId: "c1", startMs: at(30), endMs: at(120) },
      { id: "c", coachId: "c1", startMs: at(60), endMs: at(150) },
    ]);
    expect(result).toEqual(new Set(["a", "b", "c"]));
  });
});
