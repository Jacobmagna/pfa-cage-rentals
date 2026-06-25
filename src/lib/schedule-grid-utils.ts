// Shared, pure time-axis math for the schedule grids. The cage grid
// (schedule-grid.tsx) and program grid (program-schedule-grid.tsx) each
// carry their own copy of this math today; this module is the extracted
// source of truth used by the read-only MasterScheduleGrid. The impl is
// copied EXACTLY from schedule-grid.tsx so placements line up to the
// pixel with the live interactive grids. No React — pure functions only.

import { pfaHour, pfaMinute, pfaWallClockAt } from "@/lib/timezone";

export const SCHEDULE_GRID_FIRST_HOUR = 8;
export const SCHEDULE_GRID_LAST_HOUR = 22;
export const SCHEDULE_GRID_SLOTS =
  (SCHEDULE_GRID_LAST_HOUR - SCHEDULE_GRID_FIRST_HOUR) * 2; // 28

/**
 * Maps a [startAt, endAt) date range to its `{ col, span }` placement in
 * the CSS grid. `col` is 1-based and includes the leading label column
 * (clippedStart + 2), matching the existing grids. Returns null if the
 * range is fully outside the visible 8 AM–10 PM window. Ranges that
 * straddle an edge are clipped to the window.
 *
 * Copied EXACTLY from schedule-grid.tsx placeOnGrid.
 */
export function placeOnGrid(
  startAt: Date,
  endAt: Date,
): { col: number; span: number } | null {
  const startSlots =
    (pfaHour(startAt) - SCHEDULE_GRID_FIRST_HOUR) * 2 +
    Math.floor(pfaMinute(startAt) / 30);
  const endSlots =
    (pfaHour(endAt) - SCHEDULE_GRID_FIRST_HOUR) * 2 +
    Math.ceil(pfaMinute(endAt) / 30);
  const clippedStart = Math.max(startSlots, 0);
  const clippedEnd = Math.min(endSlots, SCHEDULE_GRID_SLOTS);
  if (clippedEnd <= clippedStart) return null;
  return { col: clippedStart + 2, span: clippedEnd - clippedStart };
}

/**
 * Vertical analog of placeOnGrid: maps a [startAt, endAt) date range to its
 * `{ row, rowSpan }` placement on a VERTICAL time axis (time-of-day runs down
 * the rows instead of across the columns). `row` is 1-based over the
 * SCHEDULE_GRID_SLOTS slot rows (the caller adds any leading header row).
 * Returns null if the range is fully outside the visible 8 AM–10 PM window.
 * Ranges that straddle an edge are clipped to the window — identical slot
 * math to placeOnGrid.
 */
export function placeVerticalOnGrid(
  startAt: Date,
  endAt: Date,
): { row: number; rowSpan: number } | null {
  const startSlots =
    (pfaHour(startAt) - SCHEDULE_GRID_FIRST_HOUR) * 2 +
    Math.floor(pfaMinute(startAt) / 30);
  const endSlots =
    (pfaHour(endAt) - SCHEDULE_GRID_FIRST_HOUR) * 2 +
    Math.ceil(pfaMinute(endAt) / 30);
  const clippedStart = Math.max(startSlots, 0);
  const clippedEnd = Math.min(endSlots, SCHEDULE_GRID_SLOTS);
  if (clippedEnd <= clippedStart) return null;
  return { row: clippedStart + 1, rowSpan: Math.max(1, clippedEnd - clippedStart) };
}

/**
 * The UTC instant at the START of grid slot `slotIndex` on the PFA day of
 * `selectedDate`. Slot 0 = 8:00 AM, slot 1 = 8:30 AM, … (FIRST_HOUR + a
 * half-hour step). Inverse of the placeOnGrid slot math, used by
 * click-to-add to turn a clicked empty cell into a real start time. Mirrors
 * the inline math in the interactive grids' openCreateAt.
 */
export function slotStartAt(selectedDate: Date, slotIndex: number): Date {
  return pfaWallClockAt(
    selectedDate,
    SCHEDULE_GRID_FIRST_HOUR + Math.floor(slotIndex / 2),
    (slotIndex % 2) * 30,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// 15-minute variants (PROGRAM / "work" schedules only). #8: programs need
// 15-min resolution so admins can schedule e.g. 4:15–5:00 work blocks and
// they render aligned; CAGE rentals stay on the 30-min exports above. The
// facility window is unchanged (8 AM–10 PM); a 15-min slot is a quarter-hour
// so the same window splits into 56 slots instead of 28.
// ─────────────────────────────────────────────────────────────────────────

export const PROGRAM_GRID_SLOTS =
  (SCHEDULE_GRID_LAST_HOUR - SCHEDULE_GRID_FIRST_HOUR) * 4; // 56

/**
 * 15-min analog of placeOnGrid. Minutes bucket by 15 (floor on the start,
 * ceil on the end). `col` is 1-based with NO leading label column
 * (clippedStart + 1), matching the admin program grid (template is
 * `repeat(SLOTS, …)`). Returns null if fully outside the 8 AM–10 PM window;
 * ranges straddling an edge are clipped to it.
 */
export function placeOnGrid15(
  startAt: Date,
  endAt: Date,
): { col: number; span: number } | null {
  const startSlots =
    (pfaHour(startAt) - SCHEDULE_GRID_FIRST_HOUR) * 4 +
    Math.floor(pfaMinute(startAt) / 15);
  const endSlots =
    (pfaHour(endAt) - SCHEDULE_GRID_FIRST_HOUR) * 4 +
    Math.ceil(pfaMinute(endAt) / 15);
  const clippedStart = Math.max(startSlots, 0);
  const clippedEnd = Math.min(endSlots, PROGRAM_GRID_SLOTS);
  if (clippedEnd <= clippedStart) return null;
  return { col: clippedStart + 1, span: clippedEnd - clippedStart };
}

/**
 * Vertical 15-min analog of placeVerticalOnGrid. `row` is 1-based over the
 * 56 slot rows (the caller adds any leading header row). Same 15-min bucket
 * math + clamping as placeOnGrid15.
 */
export function placeVerticalOnGrid15(
  startAt: Date,
  endAt: Date,
): { row: number; rowSpan: number } | null {
  const startSlots =
    (pfaHour(startAt) - SCHEDULE_GRID_FIRST_HOUR) * 4 +
    Math.floor(pfaMinute(startAt) / 15);
  const endSlots =
    (pfaHour(endAt) - SCHEDULE_GRID_FIRST_HOUR) * 4 +
    Math.ceil(pfaMinute(endAt) / 15);
  const clippedStart = Math.max(startSlots, 0);
  const clippedEnd = Math.min(endSlots, PROGRAM_GRID_SLOTS);
  if (clippedEnd <= clippedStart) return null;
  return {
    row: clippedStart + 1,
    rowSpan: Math.max(1, clippedEnd - clippedStart),
  };
}

/**
 * The UTC instant at the START of 15-min program slot `slotIndex` on the PFA
 * day of `selectedDate`. Slot 0 = 8:00, slot 1 = 8:15, slot 2 = 8:30, … —
 * the inverse of placeOnGrid15's slot math, used by click-to-add.
 */
export function slotStartAt15(selectedDate: Date, slotIndex: number): Date {
  return pfaWallClockAt(
    selectedDate,
    SCHEDULE_GRID_FIRST_HOUR + Math.floor(slotIndex / 4),
    (slotIndex % 4) * 15,
  );
}

/**
 * Expands a set of selected grid-cell keys
 * (`${date}|${resourceId}|${slotIndex}`) into structured slot descriptors.
 * Shared by the multi-resource batch UIs so the key format + slot→time math
 * live in exactly one place.
 *
 * The leading `date` ("YYYY-MM-DD", PFA-local) is what lets a selection span
 * MULTIPLE days: the coach picks slots on one day, navigates to another, and
 * the earlier picks persist, so one batch books across several days. We split
 * on "|" and treat the FIRST part as the date, the LAST as the slotIndex, and
 * everything between as the resourceId (resourceIds never contain "|", but this
 * stays safe if one ever did). slotIndex maps to a 30-min half-hour offset from
 * `firstHour`: hour = firstHour + floor(idx/2), minute = (idx%2)*30.
 *
 * Output is sorted deterministically by (date, resourceId, slotIndex) so two
 * equal selections always expand to byte-identical arrays — and so the batch UI
 * can group them day-by-day, then cage-by-cage. Empty input yields []. Pure +
 * unit-testable.
 */
export function expandSlotKeys(
  keys: Iterable<string>,
  firstHour: number,
): Array<{
  date: string;
  resourceId: string;
  slotIndex: number;
  hour: number;
  minute: number;
}> {
  const out: Array<{
    date: string;
    resourceId: string;
    slotIndex: number;
    hour: number;
    minute: number;
  }> = [];
  for (const key of keys) {
    const parts = key.split("|");
    if (parts.length < 3) continue; // malformed — need date|resourceId|slotIndex
    const date = parts[0];
    const slotIndex = Number(parts[parts.length - 1]);
    const resourceId = parts.slice(1, -1).join("|");
    if (
      date.length === 0 ||
      resourceId.length === 0 ||
      !Number.isInteger(slotIndex)
    ) {
      continue;
    }
    out.push({
      date,
      resourceId,
      slotIndex,
      hour: firstHour + Math.floor(slotIndex / 2),
      minute: (slotIndex % 2) * 30,
    });
  }
  out.sort((a, b) =>
    a.date !== b.date
      ? a.date < b.date
        ? -1
        : 1
      : a.resourceId === b.resourceId
        ? a.slotIndex - b.slotIndex
        : a.resourceId < b.resourceId
          ? -1
          : 1,
  );
  return out;
}

/**
 * 24-hour hour number → "8 AM" / "12 PM" / "10 PM". Copied from
 * schedule-grid.tsx formatHour.
 */
export function formatGridHour(hour24: number): string {
  if (hour24 === 0) return "12 AM";
  if (hour24 === 12) return "12 PM";
  if (hour24 < 12) return `${hour24} AM`;
  return `${hour24 - 12} PM`;
}
