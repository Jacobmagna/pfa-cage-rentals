import { describe, expect, it } from "vitest";
import {
  SCHEDULE_GRID_FIRST_HOUR,
  SCHEDULE_GRID_LAST_HOUR,
  SCHEDULE_GRID_SLOTS,
  formatGridHour,
  placeOnGrid,
} from "./schedule-grid-utils";
import { pfaWallClockAt } from "./timezone";

// Any in-range reference day works; the math is wall-clock relative.
const refDate = pfaWallClockAt(new Date("2026-05-01T12:00:00Z"), 12, 0);

describe("schedule-grid constants", () => {
  it("spans 8 AM–10 PM in 28 half-hour slots", () => {
    expect(SCHEDULE_GRID_FIRST_HOUR).toBe(8);
    expect(SCHEDULE_GRID_LAST_HOUR).toBe(22);
    expect(SCHEDULE_GRID_SLOTS).toBe(28);
  });
});

describe("placeOnGrid", () => {
  it("places a 9:00–10:30 block at col 4, span 3", () => {
    const start = pfaWallClockAt(refDate, 9, 0);
    const end = pfaWallClockAt(refDate, 10, 30);
    // startSlots = (9-8)*2 + 0 = 2 → col = 2 + 2 = 4
    expect(placeOnGrid(start, end)).toEqual({ col: 4, span: 3 });
  });

  it("places an 8:00–8:30 block at col 2, span 1", () => {
    const start = pfaWallClockAt(refDate, 8, 0);
    const end = pfaWallClockAt(refDate, 8, 30);
    expect(placeOnGrid(start, end)).toEqual({ col: 2, span: 1 });
  });

  it("returns null for a block entirely before 8 AM", () => {
    const start = pfaWallClockAt(refDate, 6, 0);
    const end = pfaWallClockAt(refDate, 7, 0);
    expect(placeOnGrid(start, end)).toBeNull();
  });

  it("returns null for a block entirely after 10 PM", () => {
    const start = pfaWallClockAt(refDate, 22, 30);
    const end = pfaWallClockAt(refDate, 23, 0);
    expect(placeOnGrid(start, end)).toBeNull();
  });

  it("clips a block that straddles the 10 PM edge", () => {
    const start = pfaWallClockAt(refDate, 21, 30); // slot 27
    const end = pfaWallClockAt(refDate, 22, 30); // slot 29 → clipped to 28
    // col = 27 + 2 = 29, span = 28 - 27 = 1
    expect(placeOnGrid(start, end)).toEqual({ col: 29, span: 1 });
  });
});

describe("formatGridHour", () => {
  it("formats hours as 12-hour with AM/PM", () => {
    expect(formatGridHour(8)).toBe("8 AM");
    expect(formatGridHour(12)).toBe("12 PM");
    expect(formatGridHour(13)).toBe("1 PM");
    expect(formatGridHour(22)).toBe("10 PM");
  });
});
