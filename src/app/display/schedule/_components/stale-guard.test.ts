import { describe, expect, it } from "vitest";
import { STALE_AFTER_MS, shouldBlank } from "./stale-guard";

// The rule that decides whether the facility wall keeps showing a schedule
// after the connection dies. Mark asked for BLANK, on the grounds that
// "something showing the wrong time and going unnoticed" is worse than
// nothing — so getting this wrong in either direction is a real failure:
// too eager and the wall blacks out during an ordinary hiccup; too lax and
// it confidently displays a stale schedule all afternoon.

describe("shouldBlank — a live connection", () => {
  it("does not blank immediately after a fresh render", () => {
    expect(shouldBlank({ msSinceLastFresh: 0, visible: true })).toBe(false);
  });

  it("survives a single missed 30s refresh", () => {
    expect(shouldBlank({ msSinceLastFresh: 35_000, visible: true })).toBe(false);
  });

  it("survives two missed refreshes", () => {
    // The whole point of the threshold being three cycles rather than one:
    // a wall screen that blacks out on every transient blip trains people to
    // ignore it, which is the same failure as never blanking at all.
    expect(shouldBlank({ msSinceLastFresh: 65_000, visible: true })).toBe(false);
  });

  it("does not blank exactly AT the threshold", () => {
    expect(shouldBlank({ msSinceLastFresh: STALE_AFTER_MS, visible: true })).toBe(false);
  });
});

describe("shouldBlank — a dead connection", () => {
  it("blanks just past the threshold", () => {
    expect(shouldBlank({ msSinceLastFresh: STALE_AFTER_MS + 1, visible: true })).toBe(true);
  });

  it("blanks after three missed refreshes", () => {
    expect(shouldBlank({ msSinceLastFresh: 120_000, visible: true })).toBe(true);
  });

  it("stays blank hours later — it never gives up and starts lying again", () => {
    expect(shouldBlank({ msSinceLastFresh: 6 * 60 * 60 * 1000, visible: true })).toBe(true);
  });
});

describe("shouldBlank — the backgrounded-tab trap", () => {
  // 🔴 THIS IS THE ONE THAT WOULD HAVE REACHED MARK AS A BUG REPORT.
  // AutoRefresh deliberately stops polling while the tab is hidden, so a tab
  // that has been backgrounded has an arbitrarily old `renderedAt` through no
  // fault of the network. On this TV that happens every single time he
  // switches the input to the Apple TV to watch a game and switches back.
  it("never blanks while the tab is hidden, however long it has been", () => {
    expect(shouldBlank({ msSinceLastFresh: 120_000, visible: false })).toBe(false);
    expect(shouldBlank({ msSinceLastFresh: 6 * 60 * 60 * 1000, visible: false })).toBe(false);
  });

  it("visibility is what separates the two cases — the control", () => {
    // Same elapsed time, opposite answers. Without this pairing the test
    // above would pass just as happily against a function that never blanks
    // at all (discipline rule 15: pair every negative with a positive control
    // on the same call).
    const elapsed = STALE_AFTER_MS + 30_000;
    expect(shouldBlank({ msSinceLastFresh: elapsed, visible: false })).toBe(false);
    expect(shouldBlank({ msSinceLastFresh: elapsed, visible: true })).toBe(true);
  });
});
