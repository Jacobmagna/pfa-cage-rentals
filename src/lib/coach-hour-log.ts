// QA10 W3.7 — pure helpers for the schedule-aware coach Hour Log.
//
// Both functions are PURE and take time as numeric epoch-ms arguments —
// no `new Date()` / `Date.now()` inside — so they're deterministically
// unit-testable and safe to call on either the server or the client.
//
// `now` is always passed in by the caller (the server component reads it
// once per request; the client passes the same instant it rendered with).

// A scheduled block is "confirmable now" when the current moment is
// within 15 minutes of the block's END (just-ended or about-to-end). The
// window is symmetric: 15 min before the end through 15 min after it.
export const CONFIRM_WINDOW_MS = 15 * 60_000;

/**
 * True iff `now` is within CONFIRM_WINDOW_MS of the block's end time, on
 * either side (|now - end| <= 15 min). This is the one-click "Confirm
 * these hours" eligibility test for a coach's scheduled program block.
 */
export function isBlockConfirmable(blockEndMs: number, nowMs: number): boolean {
  return Math.abs(nowMs - blockEndMs) <= CONFIRM_WINDOW_MS;
}

/**
 * True iff `log` matches ANY of the coach's scheduled `blocks`: same
 * programId AND a half-open time overlap (lStart < bEnd && lEnd > bStart).
 *
 * Used to decide the History "Unscheduled" flag — a log with NO matching
 * block is flagged — and (in `isBlockConfirmable`'s caller) to drop a
 * block the coach has already logged a matching hour for.
 *
 * Half-open overlap means two intervals that merely touch at an endpoint
 * (one ends exactly when the other starts) do NOT count as overlapping.
 */
export function isLogScheduled(
  log: { programId: string; startMs: number; endMs: number },
  blocks: { programId: string; startMs: number; endMs: number }[],
): boolean {
  return blocks.some(
    (block) =>
      block.programId === log.programId &&
      log.startMs < block.endMs &&
      log.endMs > block.startMs,
  );
}
