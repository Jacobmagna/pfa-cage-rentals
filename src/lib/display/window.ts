// The rolling window for the facility TV display.
//
// Mark's requirement, in his own words: "If it's 2 p.m. right now, we want to
// be able to show like from 1:30 on... when it's 3 o'clock, we see from 2:30
// till the end of the day or till the screen can hold. And then when it's 4
// o'clock, we see 3:30 on."
//
// So: a window that starts ~30 minutes in the PAST (which keeps a session
// that is currently in progress on the screen) and runs forward a BOUNDED
// number of hours. The bound is deliberate and was tightened on 2026-08-27 —
// the original scope said "as far as the screen fits", and Mark's actual
// requirement is that the text stay big enough to read from across the room.
// Fitting more on the screen is the opposite of the goal.
//
// 🔴 THIS IS THE CLASS OF FEATURE THAT BREAKS ON A UTC SERVER. Every boundary
// here is computed in PFA wall-clock time via src/lib/timezone.ts, never from
// the server's local clock. Vercel runs UTC; the facility is in Los Angeles.
//
// PURE MODULE — no DB, no React, no env. That is what makes the whole thing
// provable with literals in window.test.ts.

import { pfaHour, pfaMinute, pfaWallClockAt } from "@/lib/timezone";

/** How far into the past the window starts. Mark's number, not ours. */
export const DISPLAY_LOOKBACK_MINUTES = 30;

/** Grid column size. Matches the admin schedule grid's 30-minute slots. */
export const DISPLAY_SLOT_MINUTES = 30;

/**
 * Window length when `?hours=` is absent or unusable.
 *
 * 🔴 THREE, NOT FOUR, AND THE REASON IS MEASURED RATHER THAN PREFERRED
 * (2026-08-27, Jacob's call). The original 4 was chosen before anyone had
 * seen this board loaded with real traffic, and PFA's real traffic is mostly
 * $22 THIRTY-MINUTE cage rentals — which is the narrowest bar the grid can
 * draw, one single slot wide.
 *
 * Measured on a 1920px screen, a 30-minute bar's usable text room is the slot
 * minus its `px-4`:
 *
 *     hours=2 → 396px slot / 364px text → 0 of 9 real coach names truncate
 *     hours=3 → 264px slot / 232px text → 1 of 9 ("Serena Rodriguez", 260px)
 *     hours=4 → 198px slot / 166px text → 7 of 9 truncate
 *
 * At 4 the board was clipping seven names out of nine on the facility's most
 * common booking — "Alex Milone" misses by 6px, "Nick Milone" by 7. A default
 * that truncates the majority of a real day is the wrong default, and the one
 * name that fit cleanly ("Dave Lusk") is short enough to be unrepresentative.
 *
 * ⚠️ DO NOT "FIX" A FUTURE VERSION OF THIS BY SHRINKING THE FONT. Legibility
 * from across the room is the only requirement Mark actually stated; trading
 * it for more columns inverts the feature. If more hours are ever needed, the
 * answer is `?hours=` on the URL — which is exactly why that knob exists.
 */
export const DISPLAY_DEFAULT_HOURS = 3;

/**
 * Bounds on `?hours=`. The floor stops someone rendering a useless sliver;
 * the ceiling stops someone defeating the entire point of the feature by
 * asking for the whole day back.
 */
export const DISPLAY_MIN_HOURS = 2;
export const DISPLAY_MAX_HOURS = 8;

/**
 * Facility operating hours — the same 8 AM–10 PM the admin schedule grid
 * uses (schedule-grid.tsx FIRST_HOUR/LAST_HOUR).
 *
 * 🔴 CLAMPING TO THESE IS LOAD-BEARING FOR MORE THAN COSMETICS. A TV runs 24
 * hours a day, so without a clamp the screen spends every night rendering
 * empty 1:00 AM columns and reads as broken. It ALSO makes the arithmetic
 * below DST-safe: a window pinned inside 8 AM–10 PM can never span the 2 AM
 * transition, so adding absolute milliseconds can never disagree with the
 * wall clock. Widen these hours and that guarantee goes with them.
 */
export const DISPLAY_OPEN_HOUR = 8;
export const DISPLAY_CLOSE_HOUR = 22;

const MINUTE_MS = 60_000;

export type DisplayWindow = {
  /** Inclusive start of the first slot. */
  startAt: Date;
  /** EXCLUSIVE end of the last slot — half-open, like every other window in this repo. */
  endAt: Date;
  /** Number of 30-minute columns between them. */
  slotCount: number;
};

/**
 * Reads `?hours=`. Anything unusable falls back to the default rather than
 * refusing — this is a URL typed once into a TV by someone standing on a
 * ladder, and a blank screen because they typed `?hours=four` would be a
 * worse outcome than quietly showing four hours.
 */
export function parseDisplayHours(raw: string | undefined): number {
  if (raw === undefined) return DISPLAY_DEFAULT_HOURS;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return DISPLAY_DEFAULT_HOURS;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return DISPLAY_DEFAULT_HOURS;
  return Math.min(DISPLAY_MAX_HOURS, Math.max(DISPLAY_MIN_HOURS, parsed));
}

/**
 * Floors an instant back to the nearest 30-minute PFA wall-clock boundary.
 * Done in wall-clock parts rather than by rounding the epoch, because a
 * timezone whose offset is not a whole number of half-hours would make
 * epoch-rounding land off-boundary. (PFA's is, but the next facility's may
 * not be, and this is the cheap way to not care.)
 */
function floorToSlot(instant: Date): Date {
  const hour = pfaHour(instant);
  const minute = pfaMinute(instant);
  return pfaWallClockAt(instant, hour, minute < DISPLAY_SLOT_MINUTES ? 0 : DISPLAY_SLOT_MINUTES);
}

/**
 * The window to render, given the current instant.
 *
 * Behaviour at the edges of the day, stated so nobody has to derive it:
 *   - BEFORE the facility opens, the window is pinned to the opening hours
 *     (at 6 AM you see 8 AM onward), so the first sessions of the day are
 *     already on screen when someone unlocks the door.
 *   - AFTER it closes, the window is pinned to the LAST full window of the
 *     day (at 11 PM you see the final hours), rather than rendering empty
 *     small-hours columns.
 *
 * ⚠️ Neither edge behaviour was specified by Mark — they are the defensible
 * defaults, and they are cheap to change if he wants something else (most
 * likely candidate: roll over to TOMORROW morning after close).
 */
export function computeDisplayWindow(now: Date, hours: number): DisplayWindow {
  const spanMs = hours * 60 * MINUTE_MS;

  const open = pfaWallClockAt(now, DISPLAY_OPEN_HOUR, 0);
  const close = pfaWallClockAt(now, DISPLAY_CLOSE_HOUR, 0);

  // The latest start that still leaves a full window before closing. When the
  // operating day is SHORTER than the requested window this goes negative
  // against `open`, and the max() below collapses the window onto the day.
  const latestStart = new Date(close.getTime() - spanMs);

  const ideal = floorToSlot(new Date(now.getTime() - DISPLAY_LOOKBACK_MINUTES * MINUTE_MS));

  const startMs = Math.max(open.getTime(), Math.min(ideal.getTime(), latestStart.getTime()));
  const startAt = new Date(startMs);
  const endAt = new Date(Math.min(close.getTime(), startMs + spanMs));

  const slotCount = Math.max(
    1,
    Math.round((endAt.getTime() - startAt.getTime()) / (DISPLAY_SLOT_MINUTES * MINUTE_MS)),
  );

  return { startAt, endAt, slotCount };
}

/**
 * Which grid column an instant falls in, relative to the window start.
 * May be negative (starts before the window) or >= slotCount (ends after) —
 * callers clamp. Kept unclamped so the grid can tell "this bar is cut off on
 * the left" from "this bar starts here", which is what lets an in-progress
 * session render as running off the edge instead of being silently moved.
 */
export function slotIndexFor(instant: Date, windowStart: Date): number {
  return Math.floor(
    (instant.getTime() - windowStart.getTime()) / (DISPLAY_SLOT_MINUTES * MINUTE_MS),
  );
}

/**
 * The instant each grid column starts at. Derived by stepping absolute
 * milliseconds, which is safe for exactly the reason documented on
 * DISPLAY_OPEN_HOUR: the window cannot span a DST transition.
 */
export function slotStarts(win: DisplayWindow): Date[] {
  const out: Date[] = [];
  for (let i = 0; i < win.slotCount; i += 1) {
    out.push(new Date(win.startAt.getTime() + i * DISPLAY_SLOT_MINUTES * MINUTE_MS));
  }
  return out;
}

/**
 * Half-open overlap: does [startAt, endAt) intersect the window?
 *
 * 🔴 THIS IS NOT THE PREDICATE THE MASTER SCHEDULE USES, AND THE DIFFERENCE
 * IS A REAL DEFECT IF YOU COPY THE WRONG ONE. `/master/schedule` selects rows
 * by `startAt >= dayStart AND startAt < dayEnd` — containment on the START —
 * which is fine for a whole-day view because nothing starts outside the day
 * it belongs to. On a FOUR-HOUR window it silently drops the most important
 * booking on the screen: the one that is in progress right now, which started
 * before the window opened. The half-hour lookback exists to keep exactly
 * that session visible, so containment would defeat the feature's own point.
 */
export function overlapsWindow(
  startAt: Date,
  endAt: Date,
  win: DisplayWindow,
): boolean {
  return startAt.getTime() < win.endAt.getTime() && endAt.getTime() > win.startAt.getTime();
}
