// Shared, pure time-axis math for the schedule grids. The cage grid
// (schedule-grid.tsx) and program grid (program-schedule-grid.tsx) each
// carry their own copy of this math today; this module is the extracted
// source of truth used by the read-only MasterScheduleGrid. The impl is
// copied EXACTLY from schedule-grid.tsx so placements line up to the
// pixel with the live interactive grids. No React — pure functions only.

import { pfaHour, pfaMinute } from "@/lib/timezone";

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
 * 24-hour hour number → "8 AM" / "12 PM" / "10 PM". Copied from
 * schedule-grid.tsx formatHour.
 */
export function formatGridHour(hour24: number): string {
  if (hour24 === 0) return "12 AM";
  if (hour24 === 12) return "12 PM";
  if (hour24 < 12) return `${hour24} AM`;
  return `${hour24 - 12} PM`;
}
