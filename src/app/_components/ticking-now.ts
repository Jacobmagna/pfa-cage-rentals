"use client";

// The browser's "now", kept moving while a dialog is open.
//
// Why: the admin create dialogs apply the past-rental weight room waiver (an
// admin may enter a weight room rental under an hour once its end has
// passed). A "now" read once when the dialog opened went stale: an admin who
// opened today's 2:00-2:30 PM at 2:20 (correctly refused, still in progress)
// and waited until 2:31 was still refused, with Save disabled, although the
// server would accept. With this "now" the refusal clears within one tick
// after the end passes, without reopening the dialog.
//
// A browser-only convenience: the server judges the waiver on its own clock
// and stays the authority.

import { useEffect, useState } from "react";

/** How often the dialogs re-read the browser's clock. */
export const NOW_TICK_MS = 30_000;

/**
 * Pure core: calls `onTick` with a fresh Date every `intervalMs` until the
 * returned stop function is called.
 */
export function startNowTicker(
  onTick: (now: Date) => void,
  intervalMs: number = NOW_TICK_MS,
): () => void {
  const id = setInterval(() => onTick(new Date()), intervalMs);
  return () => clearInterval(id);
}

/**
 * The browser's clock, read when the component mounts and again every
 * NOW_TICK_MS while `enabled`. The admin dialogs mount fresh on each opening
 * (a per-opening `key`), so the first value is the moment the dialog opened;
 * pass `enabled = false` while the dialog is closed so a closed dialog does
 * not re-render on a timer. The interval is cleared on unmount.
 */
export function useTickingNow(enabled: boolean): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!enabled) return;
    return startNowTicker(setNow);
  }, [enabled]);
  return now;
}
