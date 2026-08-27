import { describe, expect, it } from "vitest";
import { formatPfaTime, pfaWallClockToUtc } from "@/lib/timezone";
import {
  DISPLAY_DEFAULT_HOURS,
  DISPLAY_MAX_HOURS,
  DISPLAY_MIN_HOURS,
  computeDisplayWindow,
  overlapsWindow,
  parseDisplayHours,
  slotIndexFor,
  slotStarts,
} from "./window";

// Every instant here is built with pfaWallClockToUtc, never with `new Date()`
// or a local-time literal, so these assertions hold identically under
// America/Los_Angeles, UTC, Asia/Tokyo and America/New_York — which is the
// bar the rest of this repo's unit suite is held to.

const DAY = "2026-08-27";
const at = (time: string) => pfaWallClockToUtc(DAY, time);
const win = (time: string, hours = DISPLAY_DEFAULT_HOURS) =>
  computeDisplayWindow(at(time), hours);

describe("computeDisplayWindow — Mark's three stated cases", () => {
  // These three are lifted verbatim from the voice memo and are the whole
  // acceptance test for the rolling behaviour. If any of them changes, the
  // feature no longer does what was asked for.
  it("at 2:00 PM shows from 1:30 PM", () => {
    expect(formatPfaTime(win("14:00").startAt)).toBe("13:30");
  });

  it("at 3:00 PM shows from 2:30 PM", () => {
    expect(formatPfaTime(win("15:00").startAt)).toBe("14:30");
  });

  it("at 4:00 PM shows from 3:30 PM", () => {
    expect(formatPfaTime(win("16:00").startAt)).toBe("15:30");
  });
});

describe("computeDisplayWindow — the window advances in half-hour steps", () => {
  // A window that slid continuously would re-flow the grid every 30 seconds
  // on a wall screen, which reads as flickering rather than as updating.
  it("does not move between 2:00 and 2:29", () => {
    expect(formatPfaTime(win("14:00").startAt)).toBe("13:30");
    expect(formatPfaTime(win("14:15").startAt)).toBe("13:30");
    expect(formatPfaTime(win("14:29").startAt)).toBe("13:30");
  });

  it("steps forward exactly at 2:30", () => {
    expect(formatPfaTime(win("14:30").startAt)).toBe("14:00");
  });
});

describe("computeDisplayWindow — length and slots", () => {
  it("is `hours` long and has two slots per hour", () => {
    const w = win("14:00", 4);
    expect(formatPfaTime(w.startAt)).toBe("13:30");
    expect(formatPfaTime(w.endAt)).toBe("17:30");
    expect(w.slotCount).toBe(8);
    expect(slotStarts(w)).toHaveLength(8);
  });

  it("honours a shorter window", () => {
    const w = win("14:00", 2);
    expect(formatPfaTime(w.endAt)).toBe("15:30");
    expect(w.slotCount).toBe(4);
  });

  it("labels its slots on clean half-hour boundaries", () => {
    expect(slotStarts(win("14:00", 2)).map(formatPfaTime)).toEqual([
      "13:30",
      "14:00",
      "14:30",
      "15:00",
    ]);
  });
});

describe("computeDisplayWindow — the edges of the operating day", () => {
  // A TV runs 24 hours. Without these clamps the screen spends every night
  // rendering empty 1:00 AM columns, which reads as broken rather than as
  // closed.
  it("pins to opening time before the facility opens", () => {
    const w = win("06:00");
    expect(formatPfaTime(w.startAt)).toBe("08:00");
    expect(formatPfaTime(w.endAt)).toBe("12:00");
  });

  it("never starts before opening even at the exact open hour", () => {
    expect(formatPfaTime(win("08:00").startAt)).toBe("08:00");
  });

  it("pins to the last full window of the day after closing", () => {
    const w = win("23:00");
    expect(formatPfaTime(w.startAt)).toBe("18:00");
    expect(formatPfaTime(w.endAt)).toBe("22:00");
  });

  it("never renders past closing time", () => {
    // 8:00 PM + a 4h window would run to midnight; it must stop at 10 PM.
    // ⚠️ Note this passes on the START clamp alone — see the next test for
    // why that matters.
    const w = win("20:00");
    expect(formatPfaTime(w.endAt)).toBe("22:00");
  });

  it("clamps the END even when the start clamp cannot save it", () => {
    // 🔴 THIS TEST EXISTS BECAUSE A MUTATION SURVIVED. Deleting the
    // `Math.min(close, ...)` on endAt broke NO test: with a window shorter
    // than the 14-hour operating day, pinning the START to `close - span`
    // already guarantees the end lands on closing time, so the end clamp
    // never got a chance to run. It was a decoy, not defence-in-depth
    // (maintenance discipline rule 27).
    //
    // A window LONGER than the operating day is the only shape that reaches
    // it: the start pins to opening instead, and nothing else stops the end
    // from running into the small hours. `parseDisplayHours` cannot produce
    // this today (DISPLAY_MAX_HOURS is 8), but computeDisplayWindow is
    // exported and takes `hours` directly, and the guard is what keeps it
    // honest if the bounds are ever widened.
    const w = computeDisplayWindow(at("14:00"), 20);
    expect(formatPfaTime(w.startAt)).toBe("08:00");
    expect(formatPfaTime(w.endAt)).toBe("22:00");
    expect(w.slotCount).toBe(28); // the whole operating day, and no more
  });

  it("never produces a zero- or negative-length window", () => {
    for (const hours of [DISPLAY_MIN_HOURS, DISPLAY_DEFAULT_HOURS, DISPLAY_MAX_HOURS, 20]) {
      for (const t of ["05:00", "08:00", "14:00", "21:59", "23:59"]) {
        const w = computeDisplayWindow(at(t), hours);
        expect(w.endAt.getTime()).toBeGreaterThan(w.startAt.getTime());
        expect(w.slotCount).toBeGreaterThan(0);
      }
    }
  });
});

describe("parseDisplayHours", () => {
  it("defaults when absent", () => {
    expect(parseDisplayHours(undefined)).toBe(DISPLAY_DEFAULT_HOURS);
  });

  it("accepts a plain number", () => {
    expect(parseDisplayHours("3")).toBe(3);
    expect(parseDisplayHours(" 5 ")).toBe(5);
  });

  it("clamps rather than refusing", () => {
    expect(parseDisplayHours("1")).toBe(DISPLAY_MIN_HOURS);
    expect(parseDisplayHours("99")).toBe(DISPLAY_MAX_HOURS);
  });

  it("falls back to the default on junk instead of blanking the wall", () => {
    // Someone typed this once, on a ladder, into a TV remote.
    expect(parseDisplayHours("four")).toBe(DISPLAY_DEFAULT_HOURS);
    expect(parseDisplayHours("")).toBe(DISPLAY_DEFAULT_HOURS);
    expect(parseDisplayHours("-2")).toBe(DISPLAY_DEFAULT_HOURS);
    expect(parseDisplayHours("3.5")).toBe(DISPLAY_DEFAULT_HOURS);
  });
});

describe("overlapsWindow — and why containment would be a defect", () => {
  const w = win("14:00"); // 13:30 → 17:30

  it("keeps a session already in progress when the window opens", () => {
    // 🔴 THE ONE THAT MATTERS. A session running 1:00–3:00 PM is the single
    // most important thing on a 2 PM screen, and it started BEFORE the
    // window. The half-hour lookback exists precisely to keep it visible.
    expect(overlapsWindow(at("13:00"), at("15:00"), w)).toBe(true);
  });

  it("is dropped by the containment predicate the master schedule uses", () => {
    // The POSITIVE CONTROL for the test above: this restates
    // `/master/schedule`'s `startAt >= windowStart` filter and shows it
    // returning the WRONG answer for the same session. Without this, the
    // test above passes without demonstrating that anything was actually at
    // stake.
    const containsByStart = at("13:00").getTime() >= w.startAt.getTime();
    expect(containsByStart).toBe(false);
  });

  it("keeps a session that runs off the right-hand edge", () => {
    expect(overlapsWindow(at("17:00"), at("19:00"), w)).toBe(true);
  });

  it("keeps a session wholly inside", () => {
    expect(overlapsWindow(at("14:00"), at("15:00"), w)).toBe(true);
  });

  it("excludes a session that ended exactly when the window opened", () => {
    // Half-open: touching endpoints do not overlap. Same convention as
    // isLogScheduled / findOverlappingLogIds elsewhere in this repo.
    expect(overlapsWindow(at("12:00"), at("13:30"), w)).toBe(false);
  });

  it("excludes a session that starts exactly when the window closes", () => {
    expect(overlapsWindow(at("17:30"), at("18:30"), w)).toBe(false);
  });

  it("excludes sessions wholly outside on either side", () => {
    expect(overlapsWindow(at("09:00"), at("10:00"), w)).toBe(false);
    expect(overlapsWindow(at("19:00"), at("20:00"), w)).toBe(false);
  });
});

describe("slotIndexFor", () => {
  const w = win("14:00"); // 13:30 → 17:30

  it("is 0 at the window start", () => {
    expect(slotIndexFor(at("13:30"), w.startAt)).toBe(0);
  });

  it("counts half-hour columns", () => {
    expect(slotIndexFor(at("14:00"), w.startAt)).toBe(1);
    expect(slotIndexFor(at("15:30"), w.startAt)).toBe(4);
  });

  it("goes NEGATIVE for something that started before the window", () => {
    // Deliberately unclamped — the grid needs to know a bar is cut off on
    // the left so it can render it running off the edge, rather than
    // silently sliding it to the first column and lying about when it began.
    expect(slotIndexFor(at("13:00"), w.startAt)).toBe(-1);
    expect(slotIndexFor(at("12:00"), w.startAt)).toBe(-3);
  });

  it("floors a mid-slot instant to its column", () => {
    expect(slotIndexFor(at("14:15"), w.startAt)).toBe(1);
  });
});
