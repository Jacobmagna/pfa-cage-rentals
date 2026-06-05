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
  | { kind: "session"; coachFirstName: string; isOwn: boolean }
  | { kind: "block"; reason: string }
  | null;

// A booking (session) on this resource, reduced to ms range + identity.
export type SlotSession = {
  startMs: number;
  endMs: number;
  coachFirstName: string;
  isOwn: boolean;
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
      occupant: { kind: "session", coachFirstName: s.coachFirstName, isOwn: false },
    };
  }

  if (own) {
    return {
      state: "own",
      occupant: { kind: "session", coachFirstName: own.coachFirstName, isOwn: true },
    };
  }

  return { state: "free", occupant: null };
}

/**
 * Whether a 1-hour booking is allowed starting at `slotIndex` on a
 * resource. True iff:
 *   - this slot is free, AND
 *   - the NEXT 30-min slot is also free, AND
 *   - the next slot is still within the 8 AM–10 PM window (i.e. this
 *     slot is not the last slot of the day).
 *
 * `slotState(i)` returns the state of slot index `i`; `totalSlots` is
 * the number of slots in the day (SCHEDULE_GRID_SLOTS = 28). The caller
 * supplies a state accessor so this stays pure and decoupled from how
 * the grid stores its slots.
 */
export function canBookOneHour(args: {
  slotIndex: number;
  totalSlots: number;
  slotState: (slotIndex: number) => SlotState;
}): boolean {
  const { slotIndex, totalSlots, slotState } = args;
  const nextIndex = slotIndex + 1;
  // Last slot of the day → no room for a back-to-back hour.
  if (nextIndex >= totalSlots) return false;
  if (slotState(slotIndex) !== "free") return false;
  if (slotState(nextIndex) !== "free") return false;
  return true;
}
