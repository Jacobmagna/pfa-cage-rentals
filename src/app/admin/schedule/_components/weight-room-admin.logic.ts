// The weight room choices and copy for the admin screens: the two create
// dialogs (schedule-create-dialog.tsx, session-form-dialog.tsx in create
// mode), and the two grids' click-to-create and drag-to-move
// (schedule-grid.tsx, editable-master-schedule.tsx). The range refusal is
// also used by the coach form (log-session-form.tsx), so the coach and the
// admin read the same sentence.
//
// Why these are decided HERE, in the browser: a production build strips the
// message (and the class) from an error a server action throws, so a
// `catch (err)` can never show the real reason. Each screen decides the
// weight room refusal from facts it already has before it calls the server.
// The server guard stays as the backstop.
//
// Pure: no React, no fetching. The minimum and the length wording come from
// @/lib/weight-room-minimum so the screens and the server can never disagree;
// the grid's last time comes from @/lib/schedule-grid-utils.

import {
  WEIGHT_ROOM_MINIMUM_MINUTES,
  formatRentalLength,
  isBelowWeightRoomMinimum,
} from "@/lib/weight-room-minimum";
import { SCHEDULE_GRID_LAST_HOUR } from "@/lib/schedule-grid-utils";
import { formatPfaTime12h, pfaWallClockAt } from "@/lib/timezone";

const SLOT_MINUTES = 30;
const MINIMUM_MS = WEIGHT_ROOM_MINIMUM_MINUTES * 60_000;

/** Shown in a create dialog when a weight room range is under an hour. */
export const WEIGHT_ROOM_RANGE_REFUSAL =
  "Weight room rentals are one hour minimum. Make the end time at least 1 hour after the start.";

/**
 * The inline refusal for a weight room range under an hour, shared by the
 * coach form ("Prefer the form?") and both admin create dialogs. Shown only
 * when the range is already refused.
 *
 * When an hour from the start would run past the grid's last time (10:00 PM,
 * SCHEDULE_GRID_LAST_HOUR), moving the end time cannot help, so the sentence
 * names the last start that can make an hour ("9:00 PM") instead. A start of
 * exactly that time can still make an hour and keeps the usual sentence.
 */
export function weightRoomRangeRefusal(rangeStart: Date | null): string {
  if (rangeStart === null) return WEIGHT_ROOM_RANGE_REFUSAL;
  const gridEnd = pfaWallClockAt(rangeStart, SCHEDULE_GRID_LAST_HOUR, 0);
  if (rangeStart.getTime() + MINIMUM_MS <= gridEnd.getTime()) {
    return WEIGHT_ROOM_RANGE_REFUSAL;
  }
  const lastHourStart = new Date(gridEnd.getTime() - MINIMUM_MS);
  return `Weight room rentals are one hour minimum, and the last hour starts at ${formatPfaTime12h(lastHourStart)}. Pick an earlier start.`;
}

export type WeightRoomRangeStatus =
  /** Start or end not filled in yet: show nothing, the server validates. */
  | { kind: "incomplete" }
  /** Under an hour (or an end not after the start): refuse inline. */
  | { kind: "too-short" }
  /** One rental of `length` ("1 hr", "1 hr 30 min"). */
  | { kind: "ok"; length: string };

/**
 * What a create dialog shows for a WEIGHT ROOM range. The whole range is one
 * rental, so the only question is whether it makes an hour. The caller asks
 * only for a weight room; a cage or bullpen range never comes here.
 */
export function weightRoomRangeStatus(
  rangeStart: Date | null,
  rangeEnd: Date | null,
): WeightRoomRangeStatus {
  if (rangeStart === null || rangeEnd === null) return { kind: "incomplete" };
  if (isBelowWeightRoomMinimum(rangeStart, rangeEnd)) return { kind: "too-short" };
  return {
    kind: "ok",
    length: formatRentalLength(minutesBetween(rangeStart, rangeEnd)),
  };
}

/**
 * A drag keeps the rental's length. Dropped on a weight room, a rental under
 * an hour is refused before anything is sent, with this message. `null` means
 * the move may go to the server (which still checks overlaps and blocks).
 */
export function weightRoomMoveRefusal(args: {
  targetIsWeightRoom: boolean;
  startAt: Date;
  endAt: Date;
}): string | null {
  if (!args.targetIsWeightRoom) return null;
  if (!isBelowWeightRoomMinimum(args.startAt, args.endAt)) return null;
  const length = formatRentalLength(minutesBetween(args.startAt, args.endAt));
  return `Weight room rentals are one hour minimum. This rental is ${length}, so it can't be moved there. Open it and make it at least 1 hour first.`;
}

/**
 * How long the create dialog's range starts when an admin clicks ONE empty
 * cell (both grids use 30-minute cells). A weight room starts at an hour,
 * unless an hour from that cell would run past the grid's last cell; then it
 * stays 30 minutes and the dialog's inline refusal explains why.
 */
export function emptyCellPrefillMinutes(args: {
  isWeightRoom: boolean;
  slotIndex: number;
  slotCount: number;
}): 30 | 60 {
  if (!args.isWeightRoom) return 30;
  const slotsNeeded = WEIGHT_ROOM_MINIMUM_MINUTES / SLOT_MINUTES;
  return args.slotIndex + slotsNeeded <= args.slotCount ? 60 : 30;
}

function minutesBetween(startAt: Date, endAt: Date): number {
  return Math.round((endAt.getTime() - startAt.getTime()) / 60_000);
}
