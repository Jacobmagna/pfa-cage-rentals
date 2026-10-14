// The weight room choices and copy for the two coach calendar panels
// (cage-slot-booking.tsx, the one-tap panel; cage-batch-booking.tsx,
// "Select multiple slots").
//
// Why the refusals are built HERE, in the browser: a production build
// strips the message (and the class) from an error a server action throws,
// so a `catch (err)` on the calendar can only ever show its generic
// fallback. The calendar therefore decides every weight room refusal before
// it calls the server, from facts it already has for the displayed day. The
// server guard stays as the backstop.
//
// Pure: no React, no fetching. The minimum and the merging come from
// @/lib/weight-room-minimum so the two can never disagree.

import type { SlotState } from "@/lib/coach-calendar";
import {
  WEIGHT_ROOM_MINIMUM_MINUTES,
  findLoneWeightRoomPicks,
  formatRentalLength,
  isBelowWeightRoomMinimum,
  mergeContiguousWeightRoomSlots,
} from "@/lib/weight-room-minimum";
import { formatPfaDateMedium, formatPfaTime12h } from "@/lib/timezone";
import { SCHEDULE_GRID_SLOTS } from "@/lib/schedule-grid-utils";

const SLOT_MINUTES = 30;
const SLOT_MS = SLOT_MINUTES * 60_000;

/** One picked 30-min calendar slot, as the batch panel builds it. */
export type BatchPick = {
  /** PFA-local day, "YYYY-MM-DD". */
  date: string;
  resourceId: string;
  /** Column on the day's grid (0 = 8:00 AM). */
  slotIndex: number;
  startAt: Date;
  endAt: Date;
};

/**
 * A typed weight room length, made bookable: rounded DOWN to a multiple of
 * 30, then held to [60, maxDurationMin]. Anything that is not a number reads
 * as an hour. When less than an hour is free (`maxDurationMin` < 60) the
 * result is `maxDurationMin`: the panel shows a refusal there and never
 * books, so the length only feeds the header.
 */
export function clampWeightRoomDuration(
  candidate: number,
  maxDurationMin: number,
): number {
  const whole = Number.isFinite(candidate)
    ? Math.floor(candidate / SLOT_MINUTES) * SLOT_MINUTES
    : WEIGHT_ROOM_MINIMUM_MINUTES;
  const atLeastAnHour = Math.max(whole, WEIGHT_ROOM_MINIMUM_MINUTES);
  return Math.min(atLeastAnHour, maxDurationMin);
}

/**
 * What the one-tap refusal needs to know about the tapped slot's two
 * neighbors on the same resource and day. The half hour before the first
 * slot of the day does not exist, so it is never free.
 */
export function oneTapNeighborFacts(args: {
  slotIndex: number;
  totalSlots: number;
  stateAt: (slotIndex: number) => SlotState;
}): { prevSlotFree: boolean; nextToOwnRental: boolean } {
  const { slotIndex, totalSlots, stateAt } = args;
  const prev = slotIndex > 0 ? stateAt(slotIndex - 1) : null;
  const next = slotIndex + 1 < totalSlots ? stateAt(slotIndex + 1) : null;
  return {
    prevSlotFree: prev === "free",
    nextToOwnRental: prev === "own" || next === "own",
  };
}

/**
 * The one-tap panel's refusal when less than an hour is free from the
 * tapped slot. Two lines: the rule, then exactly one way forward.
 *
 * `maxDurationMin` is the free run from the tapped slot (the panel's own
 * prop). At 0 the tapped slot itself is taken (a refresh revealed it), so
 * the panel says that instead and suggests nothing but another time.
 */
export function oneTapWeightRoomRefusal(args: {
  resourceName: string;
  startAt: Date;
  prevSlotFree: boolean;
  nextToOwnRental: boolean;
  maxDurationMin: number;
}): string[] {
  const { resourceName, startAt, prevSlotFree, nextToOwnRental } = args;
  if (args.maxDurationMin <= 0) {
    return [
      `${formatPfaTime12h(startAt)} on ${resourceName} is no longer free.`,
      "Pick another time.",
    ];
  }
  const first = `Weight room rentals are one hour minimum, and only 30 minutes is free from ${formatPfaTime12h(startAt)} on ${resourceName}.`;
  if (prevSlotFree) {
    const prevStart = formatPfaTime12h(new Date(startAt.getTime() - SLOT_MS));
    const tappedEnd = formatPfaTime12h(new Date(startAt.getTime() + SLOT_MS));
    return [
      first,
      `Tap ${prevStart} instead to book ${prevStart} – ${tappedEnd}.`,
    ];
  }
  if (nextToOwnRental) {
    return [
      first,
      "It sits next to your own rental. To make that rental longer, edit it on My rentals.",
    ];
  }
  return [first, "Pick another time."];
}

/**
 * The batch panel's refusal: the rule, then one line per weight room pick
 * that does not make an hour once back-to-back picks are joined, in
 * date-then-time order. An EMPTY array means nothing is refused.
 *
 * `slotState` answers for the DISPLAYED day only; a pick on another day
 * gets the suggestion that needs no availability.
 */
export function batchWeightRoomRefusal(args: {
  rows: readonly BatchPick[];
  isWeightRoom: (resourceId: string) => boolean;
  resourceName: (resourceId: string) => string;
  displayedDate: string;
  slotState: (resourceId: string, slotIndex: number) => SlotState;
}): string[] {
  const { rows, isWeightRoom, resourceName, displayedDate, slotState } = args;
  const lone = findLoneWeightRoomPicks(rows, isWeightRoom);
  if (lone.length === 0) return [];

  const lines = lone
    .map((slot, order) => ({ slot, order }))
    .sort(
      (a, b) =>
        a.slot.startAt.getTime() - b.slot.startAt.getTime() ||
        a.order - b.order,
    )
    .map(({ slot }) => {
      // Back to the pick it came from, for its day and grid column.
      const row = rows.find(
        (r) =>
          r.resourceId === slot.resourceId &&
          r.startAt.getTime() === slot.startAt.getTime(),
      );
      const suggestion = lonePickSuggestion({
        row,
        displayedDate,
        slotState,
      });
      return `${formatPfaDateMedium(slot.startAt)}, ${formatPfaTime12h(slot.startAt)} on ${resourceName(slot.resourceId)} is a single half hour. ${suggestion}`;
    });

  return ["Weight room rentals are one hour minimum.", ...lines];
}

// The way forward for one lone pick, checked in a fixed order. A neighbor
// off the day's grid (before the first slot, after the last) is not free.
function lonePickSuggestion(args: {
  row: BatchPick | undefined;
  displayedDate: string;
  slotState: (resourceId: string, slotIndex: number) => SlotState;
}): string {
  const { row, displayedDate, slotState } = args;
  if (!row || row.date !== displayedDate) {
    return "Add the half hour before or after it, or remove it.";
  }
  const before =
    row.slotIndex > 0 ? slotState(row.resourceId, row.slotIndex - 1) : null;
  const after =
    row.slotIndex + 1 < SCHEDULE_GRID_SLOTS
      ? slotState(row.resourceId, row.slotIndex + 1)
      : null;
  const beforeTime = formatPfaTime12h(
    new Date(row.startAt.getTime() - SLOT_MS),
  );
  const afterTime = formatPfaTime12h(row.endAt);

  if (before === "free" && after === "free") {
    return `Add ${beforeTime} or ${afterTime} too, or remove it.`;
  }
  if (before === "free") return `Add ${beforeTime} too, or remove it.`;
  if (after === "free") return `Add ${afterTime} too, or remove it.`;
  if (before === "own" || after === "own") {
    return "Remove it, and edit your rental next to it on My rentals to make it longer.";
  }
  return "The half hours next to it are taken, so remove it.";
}

/**
 * The review list for ONE weight room spot on ONE day: the rentals that
 * will be saved, in time order, each as a range with its length. A pick
 * that does not make an hour says so.
 */
export function weightRoomRentalLines(
  slots: readonly { startAt: Date; endAt: Date }[],
): string[] {
  const SPOT = "spot";
  return mergeContiguousWeightRoomSlots(
    slots.map((s) => ({ resourceId: SPOT, startAt: s.startAt, endAt: s.endAt })),
    () => true,
  )
    .sort((a, b) => a.startAt.getTime() - b.startAt.getTime())
    .map((rental) => {
      const minutes = Math.round(
        (rental.endAt.getTime() - rental.startAt.getTime()) / 60_000,
      );
      const length = isBelowWeightRoomMinimum(rental.startAt, rental.endAt)
        ? `${formatRentalLength(minutes)}, not enough`
        : formatRentalLength(minutes);
      return `${formatPfaTime12h(rental.startAt)} – ${formatPfaTime12h(rental.endAt)} (${length})`;
    });
}

/** How many rentals a batch saves: weight room picks joined, cages one each. */
export function countSavedRentals(
  rows: readonly BatchPick[],
  isWeightRoom: (resourceId: string) => boolean,
): number {
  return mergeContiguousWeightRoomSlots(rows, isWeightRoom).length;
}
