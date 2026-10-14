// The weight room one-hour minimum, in one place.
//
// The rule: a rental on a weight room can never be shorter than one hour.
// Longer is fine. Cages and bullpens are not touched by anything here.
//
// This module is PURE and has ZERO runtime imports, on purpose: the server
// write functions (src/lib/server/session-actions.ts) import it to enforce
// the rule, and the booking screens import it to decide the same thing in the
// browser before anything is sent. One copy of the arithmetic means the two
// can never disagree. 🔴 Keep it that way: no value import here, ever. It
// knows nothing about the database; the caller says which resource ids are
// weight rooms through the `isWeightRoom` function it passes in.

export const WEIGHT_ROOM_MINIMUM_MINUTES = 60;

const MINIMUM_MS = WEIGHT_ROOM_MINIMUM_MINUTES * 60_000;

// One picked or stored stretch of time on one resource.
export type WeightRoomSlot = {
  resourceId: string;
  startAt: Date;
  endAt: Date;
  note?: string | null;
};

// Longest note the rentals table accepts (the booking schemas cap a note at
// 500 characters). A merged note is cut to this.
const NOTE_MAX_LENGTH = 500;
const NOTE_SEPARATOR = " / ";

/**
 * True when `startAt` → `endAt` is shorter than one hour. Exactly 60 minutes
 * is allowed.
 *
 * Written as "not at least an hour" rather than "less than an hour" so a
 * time that is not a real date (the length comes out as NaN, and every
 * comparison with NaN is false) is refused instead of waved through.
 */
export function isBelowWeightRoomMinimum(startAt: Date, endAt: Date): boolean {
  const lengthMs = endAt.getTime() - startAt.getTime();
  return !(lengthMs >= MINIMUM_MS);
}

/**
 * Joins back-to-back slots on the SAME weight room into one slot.
 *
 * Two taps on the calendar, 3:00-3:30 and 3:30-4:00 on Weight Room 1, are
 * one one-hour rental, not two half-hour ones. This turns the taps into the
 * rentals that will be saved.
 *
 * What it does, exactly:
 *  - A slot that is NOT on a weight room is passed through untouched (the
 *    very same object), in its original place. Cages and bullpens are never
 *    merged.
 *  - Slots on one weight room are put in time order and chained when one's
 *    end is EXACTLY the next one's start (compared by `getTime()`). A chain
 *    of two or more becomes one new slot from the first start to the last
 *    end.
 *  - A weight room slot with no neighbor is passed through untouched too.
 *  - Never joined: slots on two different resources, slots with any gap
 *    between them, and slots that overlap or repeat each other. Overlapping
 *    and duplicate slots are left as separate slots that still overlap, so
 *    the caller's existing overlap check refuses them. A slot whose end is
 *    not after its start is never joined to anything either, so it is still
 *    there for the database to refuse.
 *  - Order of the result: walk the input; a non weight room slot stays where
 *    it stands, and a chain appears where its first-seen member stood.
 *  - A merged slot's note is the distinct, trimmed, non-empty notes of its
 *    members, in time order, joined with " / " and cut to 500 characters;
 *    `null` when there are none.
 *
 * It never looks at rentals already saved, and it never changes its input.
 */
export function mergeContiguousWeightRoomSlots(
  slots: readonly WeightRoomSlot[],
  isWeightRoom: (resourceId: string) => boolean,
): WeightRoomSlot[] {
  // Input positions of the weight room slots, grouped by resource.
  const positionsByResource = new Map<string, number[]>();
  slots.forEach((slot, position) => {
    if (!isWeightRoom(slot.resourceId)) return;
    const positions = positionsByResource.get(slot.resourceId);
    if (positions) positions.push(position);
    else positionsByResource.set(slot.resourceId, [position]);
  });

  // For each weight room slot: which chain it belongs to. Every member of a
  // chain points at the same array of input positions, held in time order.
  const chainOf = new Map<number, number[]>();
  for (const positions of positionsByResource.values()) {
    // Time order: by start, then by end, then by input position so the
    // order is fully decided even for slots with identical times.
    const inTimeOrder = [...positions].sort((a, b) => {
      const byStart = slots[a].startAt.getTime() - slots[b].startAt.getTime();
      if (byStart !== 0) return byStart;
      const byEnd = slots[a].endAt.getTime() - slots[b].endAt.getTime();
      if (byEnd !== 0) return byEnd;
      return a - b;
    });

    let chain: number[] = [];
    for (const position of inTimeOrder) {
      const slot = slots[position];
      const previous =
        chain.length > 0 ? slots[chain[chain.length - 1]] : undefined;
      const joinsPrevious =
        previous !== undefined &&
        hasPositiveLength(previous) &&
        hasPositiveLength(slot) &&
        previous.endAt.getTime() === slot.startAt.getTime();
      if (!joinsPrevious) chain = [];
      chain.push(position);
      chainOf.set(position, chain);
    }
  }

  const result: WeightRoomSlot[] = [];
  const emitted = new Set<number[]>();
  slots.forEach((slot, position) => {
    const chain = chainOf.get(position);
    // Not a weight room slot, or a weight room slot with no neighbor.
    if (!chain || chain.length === 1) {
      result.push(slot);
      return;
    }
    if (emitted.has(chain)) return;
    emitted.add(chain);
    const members = chain.map((p) => slots[p]);
    result.push({
      resourceId: slot.resourceId,
      // Fresh Date objects: the merged slot shares nothing with the input.
      startAt: new Date(members[0].startAt.getTime()),
      endAt: new Date(members[members.length - 1].endAt.getTime()),
      note: mergedNote(members),
    });
  });
  return result;
}

/**
 * The weight room picks that still do not make an hour once back-to-back
 * picks have been joined. An empty array means every weight room pick is
 * fine.
 *
 * For the booking screens: it lets a screen name the exact slot that needs a
 * neighbor ("add the slot before or after 3:00 PM on Weight Room 1") before
 * anything is sent. Picks may span several days and several weight rooms;
 * each is judged on its own resource and its own stretch of time.
 */
export function findLoneWeightRoomPicks(
  slots: readonly WeightRoomSlot[],
  isWeightRoom: (resourceId: string) => boolean,
): WeightRoomSlot[] {
  return mergeContiguousWeightRoomSlots(slots, isWeightRoom).filter(
    (slot) =>
      isWeightRoom(slot.resourceId) &&
      isBelowWeightRoomMinimum(slot.startAt, slot.endAt),
  );
}

/**
 * A rental's length in words: "30 min", "1 hr", "1 hr 30 min". The same
 * wording My rentals uses. One copy, shared by the coach calendar panels and
 * the admin screens, so every weight room message says a length the same way.
 */
export function formatRentalLength(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return `${mins} min`;
  if (mins === 0) return `${hours} hr`;
  return `${hours} hr ${mins} min`;
}

function hasPositiveLength(slot: WeightRoomSlot): boolean {
  return slot.endAt.getTime() > slot.startAt.getTime();
}

// `members` is already in time order.
function mergedNote(members: readonly WeightRoomSlot[]): string | null {
  const distinct: string[] = [];
  for (const member of members) {
    const note = member.note?.trim();
    if (note && !distinct.includes(note)) distinct.push(note);
  }
  if (distinct.length === 0) return null;
  return distinct.join(NOTE_SEPARATOR).slice(0, NOTE_MAX_LENGTH);
}
