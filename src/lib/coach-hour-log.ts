// QA10 W3.7 — pure helpers for the schedule-aware coach Hour Log.
//
// Both functions are PURE and take time as numeric epoch-ms arguments —
// no `new Date()` / `Date.now()` inside — so they're deterministically
// unit-testable and safe to call on either the server or the client.
//
// `now` is always passed in by the caller (the server component reads it
// once per request; the client passes the same instant it rendered with).

// A scheduled block is "confirmable now" the moment it STARTS and stays
// confirmable open-ended (until the coach logs or cancels it) — the page
// bounds the list to a 14-day lookback. Once we're more than 1 hr past a
// block's END it's tagged "Overdue" so a coach sees what they still owe.
export const OVERDUE_AFTER_MS = 60 * 60_000; // 1 hr past end → "Overdue"

/** Confirmable from the moment the block STARTS, open-ended (until logged). */
export function isBlockConfirmable(blockStartMs: number, nowMs: number): boolean {
  return nowMs >= blockStartMs;
}

/** True once we're more than 1 hr past the block's end. */
export function isBlockOverdue(blockEndMs: number, nowMs: number): boolean {
  return nowMs > blockEndMs + OVERDUE_AFTER_MS;
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
