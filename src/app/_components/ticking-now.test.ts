// The clock the admin create dialogs judge the past-rental weight room waiver
// against: it must keep moving while the dialog is open, and stop when the
// dialog goes away.

import { afterEach, describe, expect, it, vi } from "vitest";
import { NOW_TICK_MS, startNowTicker } from "./ticking-now";

const START = new Date("2026-10-14T21:20:00.000Z");

afterEach(() => {
  vi.useRealTimers();
});

describe("startNowTicker", () => {
  it("ticks every 30 s with the clock's current time", () => {
    vi.useFakeTimers({ now: START });
    const seen: Date[] = [];
    const stop = startNowTicker((now) => seen.push(now));

    expect(NOW_TICK_MS).toBe(30_000);
    vi.advanceTimersByTime(NOW_TICK_MS - 1);
    expect(seen).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(seen.map((d) => d.toISOString())).toEqual([
      "2026-10-14T21:20:30.000Z",
    ]);

    // 11 more minutes with the dialog still open: the "now" keeps moving.
    vi.advanceTimersByTime(11 * 60_000);
    expect(seen).toHaveLength(1 + 22);
    expect(seen.at(-1)?.toISOString()).toBe("2026-10-14T21:31:30.000Z");
    stop();
  });

  it("stops ticking once stopped (the dialog closed or unmounted)", () => {
    vi.useFakeTimers({ now: START });
    const onTick = vi.fn();
    const stop = startNowTicker(onTick);
    vi.advanceTimersByTime(NOW_TICK_MS);
    expect(onTick).toHaveBeenCalledTimes(1);

    stop();
    vi.advanceTimersByTime(10 * NOW_TICK_MS);
    expect(onTick).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("honors a custom interval", () => {
    vi.useFakeTimers({ now: START });
    const onTick = vi.fn();
    const stop = startNowTicker(onTick, 1_000);
    vi.advanceTimersByTime(3_000);
    expect(onTick).toHaveBeenCalledTimes(3);
    stop();
  });
});
