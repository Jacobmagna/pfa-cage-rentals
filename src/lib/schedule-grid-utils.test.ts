import { describe, expect, it } from "vitest";
import {
  SCHEDULE_GRID_FIRST_HOUR,
  SCHEDULE_GRID_LAST_HOUR,
  SCHEDULE_GRID_SLOTS,
  formatGridHour,
  placeOnGrid,
  placeVerticalOnGrid,
  slotStartAt,
} from "./schedule-grid-utils";
import { formatPfaTime, pfaWallClockAt } from "./timezone";

// Any in-range reference day works; the math is wall-clock relative.
const refDate = pfaWallClockAt(new Date("2026-05-01T12:00:00Z"), 12, 0);

describe("schedule-grid constants", () => {
  it("spans 8 AM–10 PM in 28 half-hour slots", () => {
    expect(SCHEDULE_GRID_FIRST_HOUR).toBe(8);
    expect(SCHEDULE_GRID_LAST_HOUR).toBe(22);
    expect(SCHEDULE_GRID_SLOTS).toBe(28);
  });
});

describe("slotStartAt", () => {
  it("maps slot 0 to 8:00 AM and slot 1 to 8:30 AM", () => {
    expect(formatPfaTime(slotStartAt(refDate, 0))).toBe("08:00");
    expect(formatPfaTime(slotStartAt(refDate, 1))).toBe("08:30");
  });
  it("maps slot 2 (9:00) and the last slot (9:30 PM)", () => {
    expect(formatPfaTime(slotStartAt(refDate, 2))).toBe("09:00");
    // slot 27 = 8 + floor(27/2)=13 → 21:00 + 30 min = 21:30
    expect(formatPfaTime(slotStartAt(refDate, SCHEDULE_GRID_SLOTS - 1))).toBe(
      "21:30",
    );
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

describe("placeVerticalOnGrid", () => {
  it("places a 9:00–10:30 block at row 3, rowSpan 3", () => {
    const start = pfaWallClockAt(refDate, 9, 0);
    const end = pfaWallClockAt(refDate, 10, 30);
    // startSlots = (9-8)*2 + 0 = 2 → row = 2 + 1 = 3
    expect(placeVerticalOnGrid(start, end)).toEqual({ row: 3, rowSpan: 3 });
  });

  it("places an 8:00–8:30 block at row 1, rowSpan 1", () => {
    const start = pfaWallClockAt(refDate, 8, 0);
    const end = pfaWallClockAt(refDate, 8, 30);
    expect(placeVerticalOnGrid(start, end)).toEqual({ row: 1, rowSpan: 1 });
  });

  it("places a 9:45–10:05 block at row 4, rowSpan 1 (sub-slot rounding)", () => {
    const start = pfaWallClockAt(refDate, 9, 45); // slot 3 (floor)
    const end = pfaWallClockAt(refDate, 10, 5); // slot 5 (ceil) → 4..5
    // startSlots = (9-8)*2 + 1 = 3 → row = 4; endSlots = (10-8)*2 + 1 = 5
    expect(placeVerticalOnGrid(start, end)).toEqual({ row: 4, rowSpan: 2 });
  });

  it("returns null for a block entirely before 8 AM", () => {
    const start = pfaWallClockAt(refDate, 6, 0);
    const end = pfaWallClockAt(refDate, 7, 0);
    expect(placeVerticalOnGrid(start, end)).toBeNull();
  });

  it("returns null for a block entirely after 10 PM", () => {
    const start = pfaWallClockAt(refDate, 22, 30);
    const end = pfaWallClockAt(refDate, 23, 0);
    expect(placeVerticalOnGrid(start, end)).toBeNull();
  });

  it("clips a block that straddles the 10 PM edge", () => {
    const start = pfaWallClockAt(refDate, 21, 30); // slot 27
    const end = pfaWallClockAt(refDate, 22, 30); // slot 29 → clipped to 28
    // row = 27 + 1 = 28, rowSpan = 28 - 27 = 1
    expect(placeVerticalOnGrid(start, end)).toEqual({ row: 28, rowSpan: 1 });
  });

  it("clips a block that straddles the 8 AM edge", () => {
    const start = pfaWallClockAt(refDate, 7, 30); // slot -1 → clipped to 0
    const end = pfaWallClockAt(refDate, 8, 30); // slot 1
    // row = 0 + 1 = 1, rowSpan = 1 - 0 = 1
    expect(placeVerticalOnGrid(start, end)).toEqual({ row: 1, rowSpan: 1 });
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
