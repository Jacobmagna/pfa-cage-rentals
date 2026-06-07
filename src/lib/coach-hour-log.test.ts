import { describe, expect, it } from "vitest";
import {
  OVERDUE_AFTER_MS,
  isBlockConfirmable,
  isBlockOverdue,
  isLogScheduled,
} from "./coach-hour-log";

// A fixed reference instant so the tests read in human time. All offsets
// below are relative to this "now".
const NOW = Date.UTC(2026, 5, 5, 17, 0, 0); // 2026-06-05 17:00:00 UTC
const MIN = 60_000;

describe("isBlockConfirmable", () => {
  it("is true when the block starts exactly now (now == start)", () => {
    expect(isBlockConfirmable(NOW, NOW)).toBe(true);
  });

  it("is true once the block has started (now > start)", () => {
    expect(isBlockConfirmable(NOW - MIN, NOW)).toBe(true);
  });

  it("is true long after the block started (open-ended)", () => {
    expect(isBlockConfirmable(NOW - 5 * 24 * 60 * MIN, NOW)).toBe(true);
  });

  it("is false when the block has not started yet (now < start)", () => {
    expect(isBlockConfirmable(NOW + MIN, NOW)).toBe(false);
  });

  it("is false for a block starting far in the future", () => {
    expect(isBlockConfirmable(NOW + 3 * 60 * MIN, NOW)).toBe(false);
  });
});

describe("isBlockOverdue", () => {
  it("is false at the block's end (not yet past)", () => {
    expect(isBlockOverdue(NOW, NOW)).toBe(false);
  });

  it("is false at exactly end + 60 min (strict >)", () => {
    expect(isBlockOverdue(NOW, NOW + 60 * MIN)).toBe(false);
  });

  it("is true 1 ms past end + 60 min", () => {
    expect(isBlockOverdue(NOW, NOW + 60 * MIN + 1)).toBe(true);
  });

  it("is true far past the end", () => {
    expect(isBlockOverdue(NOW, NOW + 5 * 24 * 60 * MIN)).toBe(true);
  });

  it("uses a 1-hour overdue constant", () => {
    expect(OVERDUE_AFTER_MS).toBe(60 * 60_000);
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
