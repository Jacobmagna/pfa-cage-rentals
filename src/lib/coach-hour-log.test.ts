import { describe, expect, it } from "vitest";
import {
  CONFIRM_WINDOW_MS,
  isBlockConfirmable,
  isLogScheduled,
} from "./coach-hour-log";

// A fixed reference instant so the tests read in human time. All offsets
// below are relative to this "now".
const NOW = Date.UTC(2026, 5, 5, 17, 0, 0); // 2026-06-05 17:00:00 UTC
const MIN = 60_000;

describe("isBlockConfirmable", () => {
  it("is true when the block ends exactly now (|now - end| = 0)", () => {
    expect(isBlockConfirmable(NOW, NOW)).toBe(true);
  });

  it("is true at the exact 15-min boundary before the end", () => {
    expect(isBlockConfirmable(NOW + 15 * MIN, NOW)).toBe(true);
  });

  it("is true at the exact 15-min boundary after the end", () => {
    expect(isBlockConfirmable(NOW - 15 * MIN, NOW)).toBe(true);
  });

  it("is true just inside the window on the about-to-end side", () => {
    expect(isBlockConfirmable(NOW + 14 * MIN, NOW)).toBe(true);
  });

  it("is true just inside the window on the just-ended side", () => {
    expect(isBlockConfirmable(NOW - 14 * MIN, NOW)).toBe(true);
  });

  it("is false just outside the window before the end (16 min away)", () => {
    expect(isBlockConfirmable(NOW + 16 * MIN, NOW)).toBe(false);
  });

  it("is false just outside the window after the end (16 min away)", () => {
    expect(isBlockConfirmable(NOW - 16 * MIN, NOW)).toBe(false);
  });

  it("is false for a block ending far in the future", () => {
    expect(isBlockConfirmable(NOW + 3 * 60 * MIN, NOW)).toBe(false);
  });

  it("is false for a block that ended far in the past", () => {
    expect(isBlockConfirmable(NOW - 3 * 60 * MIN, NOW)).toBe(false);
  });

  it("uses a 15-minute window constant", () => {
    expect(CONFIRM_WINDOW_MS).toBe(15 * 60_000);
  });
});

describe("isLogScheduled", () => {
  const block = {
    programId: "prog-a",
    startMs: NOW,
    endMs: NOW + 60 * MIN,
  };

  it("matches a log identical to a block (same program, same span)", () => {
    expect(
      isLogScheduled(
        { programId: "prog-a", startMs: NOW, endMs: NOW + 60 * MIN },
        [block],
      ),
    ).toBe(true);
  });

  it("matches a log that partially overlaps a block", () => {
    expect(
      isLogScheduled(
        { programId: "prog-a", startMs: NOW + 30 * MIN, endMs: NOW + 90 * MIN },
        [block],
      ),
    ).toBe(true);
  });

  it("matches a log fully contained inside a block", () => {
    expect(
      isLogScheduled(
        { programId: "prog-a", startMs: NOW + 10 * MIN, endMs: NOW + 20 * MIN },
        [block],
      ),
    ).toBe(true);
  });

  it("matches a log that fully contains a block", () => {
    expect(
      isLogScheduled(
        { programId: "prog-a", startMs: NOW - 30 * MIN, endMs: NOW + 90 * MIN },
        [block],
      ),
    ).toBe(true);
  });

  it("does NOT match when the program differs even if times overlap", () => {
    expect(
      isLogScheduled(
        { programId: "prog-b", startMs: NOW, endMs: NOW + 60 * MIN },
        [block],
      ),
    ).toBe(false);
  });

  it("does NOT match a non-overlapping log (entirely after the block)", () => {
    expect(
      isLogScheduled(
        {
          programId: "prog-a",
          startMs: NOW + 120 * MIN,
          endMs: NOW + 180 * MIN,
        },
        [block],
      ),
    ).toBe(false);
  });

  it("does NOT match a non-overlapping log (entirely before the block)", () => {
    expect(
      isLogScheduled(
        { programId: "prog-a", startMs: NOW - 120 * MIN, endMs: NOW - 60 * MIN },
        [block],
      ),
    ).toBe(false);
  });

  it("does NOT match when intervals merely touch at the end (half-open)", () => {
    // log ends exactly when block starts → lEnd > bStart is false.
    expect(
      isLogScheduled(
        { programId: "prog-a", startMs: NOW - 60 * MIN, endMs: NOW },
        [block],
      ),
    ).toBe(false);
  });

  it("does NOT match when intervals merely touch at the start (half-open)", () => {
    // log starts exactly when block ends → lStart < bEnd is false.
    expect(
      isLogScheduled(
        { programId: "prog-a", startMs: NOW + 60 * MIN, endMs: NOW + 120 * MIN },
        [block],
      ),
    ).toBe(false);
  });

  it("matches when ANY of several blocks matches (right program + overlap)", () => {
    const blocks = [
      { programId: "prog-b", startMs: NOW, endMs: NOW + 60 * MIN },
      { programId: "prog-a", startMs: NOW + 30 * MIN, endMs: NOW + 90 * MIN },
    ];
    expect(
      isLogScheduled(
        { programId: "prog-a", startMs: NOW + 40 * MIN, endMs: NOW + 80 * MIN },
        blocks,
      ),
    ).toBe(true);
  });

  it("returns false against an empty block list", () => {
    expect(
      isLogScheduled(
        { programId: "prog-a", startMs: NOW, endMs: NOW + 60 * MIN },
        [],
      ),
    ).toBe(false);
  });
});
