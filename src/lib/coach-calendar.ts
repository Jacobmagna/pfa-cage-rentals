// Pure, React-free, DB-free slot logic for the coach "Calendly-style"
// cage calendar (/coach/sessions/new). Extracted so the per-slot
// availability decision and the 1-hour-booking rule are unit-testable
// without rendering the grid or touching the database.
//
// The grid is resource rows × 30-min slots, 8 AM–10 PM. For a single
// resource we pass in that resource's sessions + blocks (already
// reduced to millisecond ranges) and ask, for a given 30-min slot,
// what state it's in and who (if anyone) occupies it.
//
// Slot identity in the UI is `${resourceId}|${slotIndex}` — kept clean
// so the W3.5b batch-multi-select worker can build a Set of selected
// slots without reworking this module.

export type SlotState = "free" | "own" | "taken" | "blocked";

export type SlotOccupant =
  | {
      kind: "session";
      coachFirstName: string;
      isOwn: boolean;
      // Identity + the fields the coach's own-booking popup needs. `note` /
      // `removalPending` are meaningful only when isOwn (the server nulls
      // them for other coaches' bookings). startMs/endMs are the SESSION's
      // own range (may span several slots), used to label + to pick
      // delete-vs-request-removal.
      sessionId: string;
      note: string | null;
      removalPending: boolean;
      isPast: boolean;
      startMs: number;
      endMs: number;
    }
  | { kind: "block"; reason: string }
  | null;

// A booking (session) on this resource, reduced to ms range + identity.
export type SlotSession = {
  startMs: number;
  endMs: number;
  coachFirstName: string;
  isOwn: boolean;
  sessionId: string;
  // Server-computed: startAt <= now (drives delete-vs-request-removal).
  isPast: boolean;
  // Own-only (null for other coaches' bookings — enforced server-side).
  note: string | null;
  removalPending: boolean;
};

// A blocked_time on this resource, reduced to ms range + reason.
export type SlotBlock = {
  startMs: number;
  endMs: number;
  reason: string;
};

// Half-open overlap: a [aStart, aEnd) range overlaps [bStart, bEnd)
// iff aStart < bEnd && aEnd > bStart. A booking that ends exactly when
// a slot starts does NOT occupy that slot.
function overlaps(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart < bEnd && aEnd > bStart;
}

/**
 * Decide a single slot's state + occupant from the resource's sessions
 * and blocks.
 *
 * Precedence (locked by spec):
 *   1. A block OR another coach's session overlapping the slot → that
 *      state ("blocked" / "taken"), revealing only the block reason or
 *      the booking coach's first name. Blocks are checked first; if both
 *      a block and another coach's session overlap, the block wins.
 *   2. The current coach's OWN session overlapping the slot → "own".
 *   3. Otherwise → "free".
 *
 * "Another coach's session takes precedence over your own" is the
 * conservative choice: if someone else also has the slot (shouldn't
 * happen given server overlap rejection, but a race could produce it),
 * we show it as taken rather than falsely green/gold.
 */
export function computeSlotState(args: {
  slotStartMs: number;
  slotEndMs: number;
  sessions: SlotSession[];
  blocks: SlotBlock[];
}): { state: SlotState; occupant: SlotOccupant } {
  const { slotStartMs, slotEndMs, sessions, blocks } = args;

  for (const b of blocks) {
    if (overlaps(slotStartMs, slotEndMs, b.startMs, b.endMs)) {
      return { state: "blocked", occupant: { kind: "block", reason: b.reason } };
    }
  }

  let own: SlotSession | null = null;
  for (const s of sessions) {
    if (!overlaps(slotStartMs, slotEndMs, s.startMs, s.endMs)) continue;
    if (s.isOwn) {
      // Remember own, but keep scanning — another coach's overlapping
      // session takes precedence and should win the cell.
      own = own ?? s;
      continue;
    }
    return {
      state: "taken",
      occupant: {
        kind: "session",
        coachFirstName: s.coachFirstName,
        isOwn: false,
        sessionId: s.sessionId,
        note: s.note,
        removalPending: s.removalPending,
        isPast: s.isPast,
        startMs: s.startMs,
        endMs: s.endMs,
      },
    };
  }

  if (own) {
    return {
      state: "own",
      occupant: {
        kind: "session",
        coachFirstName: own.coachFirstName,
        isOwn: true,
        sessionId: own.sessionId,
        note: own.note,
        removalPending: own.removalPending,
        isPast: own.isPast,
        startMs: own.startMs,
        endMs: own.endMs,
      },
    };
  }

  return { state: "free", occupant: null };
}

/**
 * Count the consecutive "free" 30-min slots starting AT `slotIndex` on a
 * resource. The tapped slot itself counts (it's free — only free slots
 * are bookable), so the minimum useful return is 1. Scanning stops at the
 * first non-free slot OR the end of the day (`totalSlots`), whichever
 * comes first.
 *
 * This is the available headroom for a booking that begins at this slot:
 * a duration may occupy up to `maxConsecutiveFreeSlots * 30` minutes
 * without colliding with a busy slot or running past the 8 AM–10 PM
 * window. (e.g. this slot + the next two free, then a taken slot → 3.)
 *
 * `slotState(i)` returns the state of slot index `i`; `totalSlots` is the
 * number of slots in the day (SCHEDULE_GRID_SLOTS = 28). The caller
 * supplies a state accessor so this stays pure and decoupled from how the
 * grid stores its slots.
 *
 * If the tapped slot itself is somehow not free, returns 0 (nothing
 * bookable). Callers only pass free slots, so in practice this is >= 1.
 */
export function maxConsecutiveFreeSlots(args: {
  slotIndex: number;
  totalSlots: number;
  slotState: (slotIndex: number) => SlotState;
}): number {
  const { slotIndex, totalSlots, slotState } = args;
  let count = 0;
  for (let i = slotIndex; i < totalSlots; i++) {
    if (slotState(i) !== "free") break;
    count++;
  }
  return count;
}

// A single selected slot resolved to its [startHour, startMinute] +
// the 30-min [startMs, endMs) range, derived from a slot index. Used by
// the W3.5b batch booking flow — one selected slot = one 30-min session.
export type SelectedSlotRange = {
  slotIndex: number;
  hour: number;
  minute: number;
};

/**
 * Map a Set of selected slot indices → a time-sorted list of slot
 * descriptors (index + start hour/minute). The grid runs 30-min slots
 * starting at `firstHour`; slot i starts at firstHour + floor(i/2) hours,
 * minute (i % 2) * 30. The result is sorted ascending by slot index
 * (== ascending by time) so both the batch UI and the batch submit are
 * deterministic regardless of click order.
 *
 * Pure + React-free so the selection→ranges mapping is unit-testable
 * without rendering the calendar.
 */
export function selectionToSortedRanges(
  slotIndexes: Iterable<number>,
  firstHour: number,
): SelectedSlotRange[] {
  return Array.from(slotIndexes)
    .sort((a, b) => a - b)
    .map((slotIndex) => ({
      slotIndex,
      hour: firstHour + Math.floor(slotIndex / 2),
      minute: (slotIndex % 2) * 30,
    }));
}
