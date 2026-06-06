import { describe, expect, it } from "vitest";
import { assignLanes, type LaneBlock } from "./schedule-lanes";

// Helper: build a block from "HH:MM" wall-clock strings on a fixed UTC day.
// The lane math only cares about relative ordering/overlap, so a stable UTC
// base keeps the tests TZ-independent.
function block(id: string, start: string, end: string): LaneBlock {
  const at = (hhmm: string) => new Date(`2026-06-05T${hhmm}:00.000Z`);
  return { id, startAt: at(start), endAt: at(end) };
}

describe("assignLanes", () => {
  it("returns laneCount 0 and an empty map when there are no blocks", () => {
    const result = assignLanes([]);
    expect(result.laneCount).toBe(0);
    expect(result.laneByBlockId.size).toBe(0);
  });

  it("places a single block in lane 0 (laneCount 1)", () => {
    const result = assignLanes([block("a", "09:00", "10:00")]);
    expect(result.laneCount).toBe(1);
    expect(result.laneByBlockId.get("a")).toBe(0);
  });

  it("keeps non-overlapping back-to-back blocks in one lane (touching endpoints share)", () => {
    const result = assignLanes([
      block("a", "09:00", "10:00"),
      block("b", "10:00", "11:00"), // starts exactly when a ends → same lane
      block("c", "11:00", "12:00"),
    ]);
    expect(result.laneCount).toBe(1);
    expect(result.laneByBlockId.get("a")).toBe(0);
    expect(result.laneByBlockId.get("b")).toBe(0);
    expect(result.laneByBlockId.get("c")).toBe(0);
  });

  it("keeps non-overlapping blocks with gaps in one lane", () => {
    const result = assignLanes([
      block("a", "09:00", "09:30"),
      block("b", "11:00", "11:30"),
    ]);
    expect(result.laneCount).toBe(1);
    expect(result.laneByBlockId.get("a")).toBe(0);
    expect(result.laneByBlockId.get("b")).toBe(0);
  });

  it("splits two overlapping blocks into two lanes", () => {
    const result = assignLanes([
      block("a", "09:00", "10:30"),
      block("b", "10:00", "11:00"),
    ]);
    expect(result.laneCount).toBe(2);
    expect(result.laneByBlockId.get("a")).toBe(0);
    expect(result.laneByBlockId.get("b")).toBe(1);
  });

  it("splits a three-way overlap into three lanes", () => {
    const result = assignLanes([
      block("a", "09:00", "12:00"),
      block("b", "09:30", "12:00"),
      block("c", "10:00", "12:00"),
    ]);
    expect(result.laneCount).toBe(3);
    expect(result.laneByBlockId.get("a")).toBe(0);
    expect(result.laneByBlockId.get("b")).toBe(1);
    expect(result.laneByBlockId.get("c")).toBe(2);
  });

  it("reuses a freed lane for a later non-overlapping block (mix of share + stack)", () => {
    // a & b overlap (2 lanes). c starts after a ends but while b still runs →
    // reuses lane 0. d starts after both → reuses lane 0. Max concurrency 2.
    const result = assignLanes([
      block("a", "09:00", "10:00"),
      block("b", "09:30", "11:30"),
      block("c", "10:00", "11:00"),
      block("d", "11:30", "12:00"),
    ]);
    expect(result.laneCount).toBe(2);
    expect(result.laneByBlockId.get("a")).toBe(0);
    expect(result.laneByBlockId.get("b")).toBe(1);
    expect(result.laneByBlockId.get("c")).toBe(0);
    expect(result.laneByBlockId.get("d")).toBe(0);
  });

  it("is deterministic regardless of input order (sorted by start, tie-break id)", () => {
    const blocks = [
      block("c", "10:00", "12:00"),
      block("a", "09:00", "12:00"),
      block("b", "09:30", "12:00"),
    ];
    const forward = assignLanes(blocks);
    const reversed = assignLanes([...blocks].reverse());
    expect(forward.laneByBlockId.get("a")).toBe(
      reversed.laneByBlockId.get("a"),
    );
    expect(forward.laneByBlockId.get("b")).toBe(
      reversed.laneByBlockId.get("b"),
    );
    expect(forward.laneByBlockId.get("c")).toBe(
      reversed.laneByBlockId.get("c"),
    );
    expect(forward.laneCount).toBe(reversed.laneCount);
  });

  it("tie-breaks identical start times by id deterministically", () => {
    const result = assignLanes([
      block("z", "09:00", "10:00"),
      block("a", "09:00", "10:00"),
    ]);
    expect(result.laneCount).toBe(2);
    // "a" sorts first → lane 0; "z" → lane 1.
    expect(result.laneByBlockId.get("a")).toBe(0);
    expect(result.laneByBlockId.get("z")).toBe(1);
  });

  it("places every block exactly once", () => {
    const blocks = [
      block("a", "09:00", "10:00"),
      block("b", "09:30", "10:30"),
      block("c", "13:00", "14:00"),
    ];
    const result = assignLanes(blocks);
    expect(result.laneByBlockId.size).toBe(3);
    for (const b of blocks) {
      const lane = result.laneByBlockId.get(b.id);
      expect(lane).toBeDefined();
      expect(lane).toBeLessThan(result.laneCount);
      expect(lane).toBeGreaterThanOrEqual(0);
    }
  });
});
