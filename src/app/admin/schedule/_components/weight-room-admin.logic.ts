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
// The one exception the server makes (isPastRentalAdminWaiver: an ADMIN may
// enter or move a weight room rental under an hour once it is over) is
// applied here too, with the viewer's role from the server page and the
// browser's clock, so the screens never refuse what the server would allow.
// A Schedule Manager is role "coach" and is still refused. The browser's
// answer only avoids a pointless refusal; the server guard decides.
//
// Pure: no React, no fetching. The minimum and the length wording come from
// @/lib/weight-room-minimum so the screens and the server can never disagree;
// the grid's last time comes from @/lib/schedule-grid-utils.

import {
  WEIGHT_ROOM_MINIMUM_MINUTES,
  formatRentalLength,
  isBelowWeightRoomMinimum,
  isPastRentalAdminWaiver,
} from "@/lib/weight-room-minimum";
import type { ResourceType } from "@/lib/billing";
import { SCHEDULE_GRID_LAST_HOUR } from "@/lib/schedule-grid-utils";
import { formatPfaTime12h, pfaWallClockAt } from "@/lib/timezone";

const SLOT_MINUTES = 30;
const MINIMUM_MS = WEIGHT_ROOM_MINIMUM_MINUTES * 60_000;

/**
 * Who is looking at the screen, and the browser's "now". `role` comes from
 * the server page (the signed-in user's role); a Schedule Manager is "coach".
 */
export type WeightRoomViewer = {
  role: "admin" | "coach";
  now: Date;
};

// The same waiver the server guard applies, for a range on a weight room.
function waivedFor(viewer: WeightRoomViewer, startAt: Date, endAt: Date) {
  return isPastRentalAdminWaiver({
    role: viewer.role,
    startAt,
    endAt,
    now: viewer.now,
  });
}

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
 *
 * An ADMIN entering a range that is already over (it ends at or before
 * `viewer.now`) is not held to the hour, exactly as on the server; the range
 * is "ok" with its real length ("30 min"). A range whose end is not after its
 * start is still refused.
 */
export function weightRoomRangeStatus(
  rangeStart: Date | null,
  rangeEnd: Date | null,
  viewer: WeightRoomViewer,
): WeightRoomRangeStatus {
  if (rangeStart === null || rangeEnd === null) return { kind: "incomplete" };
  if (
    isBelowWeightRoomMinimum(rangeStart, rangeEnd) &&
    !waivedFor(viewer, rangeStart, rangeEnd)
  ) {
    return { kind: "too-short" };
  }
  return {
    kind: "ok",
    length: formatRentalLength(minutesBetween(rangeStart, rangeEnd)),
  };
}

/**
 * A drag keeps the rental's length. Dropped on a weight room, a rental under
 * an hour is refused before anything is sent, with this message. `null` means
 * the move may go to the server (which still checks overlaps and blocks).
 *
 * `startAt` / `endAt` are where the rental would LAND (the drop's times; the
 * length is the rental's own). An ADMIN dropping it on a time that is already
 * over is not refused, exactly as on the server: the waiver is judged on the
 * landing end, so a past half hour dragged into the future is still refused.
 *
 * `sourceType` is the type of the spot the rental is dragged FROM. Only a
 * weight room rental gets the advice to open it and make it an hour first:
 * for a cage or bullpen rental that advice would double a cage charge, so it
 * is refused without advice. A source the grid cannot find gets the same
 * no-advice sentence.
 */
export function weightRoomMoveRefusal(args: {
  targetIsWeightRoom: boolean;
  sourceType: ResourceType | undefined;
  startAt: Date;
  endAt: Date;
  viewer: WeightRoomViewer;
}): string | null {
  if (!args.targetIsWeightRoom) return null;
  if (!isBelowWeightRoomMinimum(args.startAt, args.endAt)) return null;
  if (waivedFor(args.viewer, args.startAt, args.endAt)) return null;
  const length = formatRentalLength(minutesBetween(args.startAt, args.endAt));
  if (args.sourceType === "weight_room") {
    return `Weight room rentals are one hour minimum. This rental is ${length}, so it can't be moved there. Open it and make it at least 1 hour first.`;
  }
  return `Weight room rentals are one hour minimum. This rental is ${length}, so it can't be moved onto a weight room.`;
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
