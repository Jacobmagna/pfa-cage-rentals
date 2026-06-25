import { describe, expect, it } from "vitest";
import {
  PROGRAM_GRID_SLOTS,
  SCHEDULE_GRID_FIRST_HOUR,
  SCHEDULE_GRID_LAST_HOUR,
  SCHEDULE_GRID_SLOTS,
  expandSlotKeys,
  formatGridHour,
  placeOnGrid,
  placeOnGrid15,
  placeVerticalOnGrid,
  placeVerticalOnGrid15,
  slotStartAt,
  slotStartAt15,
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

describe("PROGRAM_GRID_SLOTS (15-min)", () => {
  it("splits 8 AM–10 PM into 56 fifteen-minute slots", () => {
    expect(PROGRAM_GRID_SLOTS).toBe(56);
  });
});

describe("slotStartAt15", () => {
  it("maps slot 0/1/2/3 to 8:00, 8:15, 8:30, 8:45", () => {
    expect(formatPfaTime(slotStartAt15(refDate, 0))).toBe("08:00");
    expect(formatPfaTime(slotStartAt15(refDate, 1))).toBe("08:15");
    expect(formatPfaTime(slotStartAt15(refDate, 2))).toBe("08:30");
    expect(formatPfaTime(slotStartAt15(refDate, 3))).toBe("08:45");
  });
  it("maps slot 4 to 9:00 and the last slot to 9:45 PM", () => {
    expect(formatPfaTime(slotStartAt15(refDate, 4))).toBe("09:00");
    // slot 55 = 8 + floor(55/4)=13 → 21:00 + (55%4=3)*15 = 21:45
    expect(formatPfaTime(slotStartAt15(refDate, PROGRAM_GRID_SLOTS - 1))).toBe(
      "21:45",
    );
  });
  it("round-trips with placeOnGrid15 (slotStartAt15(n) places at col n+1)", () => {
    for (const slot of [0, 1, 5, 17, 55]) {
      const start = slotStartAt15(refDate, slot);
      const end = slotStartAt15(refDate, slot + 1);
      expect(placeOnGrid15(start, end)).toEqual({ col: slot + 1, span: 1 });
    }
  });
});

describe("placeOnGrid15", () => {
  it("places a 4:15 PM–5:00 PM block at col 34, span 3", () => {
    const start = pfaWallClockAt(refDate, 16, 15);
    const end = pfaWallClockAt(refDate, 17, 0);
    // startSlots = (16-8)*4 + 1 = 33 → col 34; endSlots = (17-8)*4 = 36 → span 3
    expect(placeOnGrid15(start, end)).toEqual({ col: 34, span: 3 });
  });

  it("places a 15-min block (8:00–8:15) at col 1, span 1", () => {
    const start = pfaWallClockAt(refDate, 8, 0);
    const end = pfaWallClockAt(refDate, 8, 15);
    expect(placeOnGrid15(start, end)).toEqual({ col: 1, span: 1 });
  });

  it("places an 8:45–9:00 block at col 4, span 1", () => {
    const start = pfaWallClockAt(refDate, 8, 45);
    const end = pfaWallClockAt(refDate, 9, 0);
    expect(placeOnGrid15(start, end)).toEqual({ col: 4, span: 1 });
  });

  it("returns null for a block entirely before 8 AM", () => {
    const start = pfaWallClockAt(refDate, 6, 0);
    const end = pfaWallClockAt(refDate, 7, 0);
    expect(placeOnGrid15(start, end)).toBeNull();
  });

  it("returns null for a block entirely after 10 PM", () => {
    const start = pfaWallClockAt(refDate, 22, 15);
    const end = pfaWallClockAt(refDate, 22, 45);
    expect(placeOnGrid15(start, end)).toBeNull();
  });

  it("clips a block that straddles the 10 PM edge", () => {
    const start = pfaWallClockAt(refDate, 21, 45); // slot 55
    const end = pfaWallClockAt(refDate, 22, 30); // slot 58 → clipped to 56
    // col = 55 + 1 = 56, span = 56 - 55 = 1
    expect(placeOnGrid15(start, end)).toEqual({ col: 56, span: 1 });
  });

  it("clips a block that straddles the 8 AM edge", () => {
    const start = pfaWallClockAt(refDate, 7, 45); // slot -1 → clamp 0
    const end = pfaWallClockAt(refDate, 8, 30); // slot 2
    expect(placeOnGrid15(start, end)).toEqual({ col: 1, span: 2 });
  });
});

describe("placeVerticalOnGrid15", () => {
  it("places a 4:15 PM–5:00 PM block at row 34, rowSpan 3", () => {
    const start = pfaWallClockAt(refDate, 16, 15);
    const end = pfaWallClockAt(refDate, 17, 0);
    expect(placeVerticalOnGrid15(start, end)).toEqual({ row: 34, rowSpan: 3 });
  });

  it("places a 30-min cage block (8:00–8:30) at row 1, rowSpan 2", () => {
    const start = pfaWallClockAt(refDate, 8, 0);
    const end = pfaWallClockAt(refDate, 8, 30);
    expect(placeVerticalOnGrid15(start, end)).toEqual({ row: 1, rowSpan: 2 });
  });

  it("places a 15-min block (8:00–8:15) at row 1, rowSpan 1", () => {
    const start = pfaWallClockAt(refDate, 8, 0);
    const end = pfaWallClockAt(refDate, 8, 15);
    expect(placeVerticalOnGrid15(start, end)).toEqual({ row: 1, rowSpan: 1 });
  });

  it("returns null for a block entirely after 10 PM", () => {
    const start = pfaWallClockAt(refDate, 22, 15);
    const end = pfaWallClockAt(refDate, 22, 45);
    expect(placeVerticalOnGrid15(start, end)).toBeNull();
  });

  it("clips a block that straddles the 10 PM edge", () => {
    const start = pfaWallClockAt(refDate, 21, 45); // slot 55
    const end = pfaWallClockAt(refDate, 22, 30); // slot 58 → clipped to 56
    expect(placeVerticalOnGrid15(start, end)).toEqual({ row: 56, rowSpan: 1 });
  });
});

describe("expandSlotKeys", () => {
  it("returns [] for empty input", () => {
    expect(expandSlotKeys([], SCHEDULE_GRID_FIRST_HOUR)).toEqual([]);
    expect(expandSlotKeys(new Set<string>(), SCHEDULE_GRID_FIRST_HOUR)).toEqual(
      [],
    );
  });

  it("expands keys across resources sorted by (date, resourceId, slotIndex)", () => {
    // Intentionally unsorted input; expect deterministic (date, resourceId,
    // slotIndex) ordering out.
    const keys = [
      "2026-05-01|cage2|0",
      "2026-05-01|cage1|3",
      "2026-05-01|cage1|0",
      "2026-05-01|bullpen1|2",
    ];
    const out = expandSlotKeys(keys, SCHEDULE_GRID_FIRST_HOUR);
    expect(out.map((s) => `${s.resourceId}|${s.slotIndex}`)).toEqual([
      "bullpen1|2",
      "cage1|0",
      "cage1|3",
      "cage2|0",
    ]);
  });

  it("spans MULTIPLE days, sorting earlier dates first", () => {
    // The cross-day selection: same cage, two days, unsorted in.
    const keys = [
      "2026-05-02|cage1|0",
      "2026-05-01|cage1|2",
      "2026-05-01|cage1|0",
    ];
    const out = expandSlotKeys(keys, SCHEDULE_GRID_FIRST_HOUR);
    expect(out.map((s) => `${s.date}|${s.slotIndex}`)).toEqual([
      "2026-05-01|0",
      "2026-05-01|2",
      "2026-05-02|0",
    ]);
  });

  it("maps slotIndex to the correct hour/minute (firstHour=8)", () => {
    const out = expandSlotKeys(
      ["2026-05-01|r|0", "2026-05-01|r|1", "2026-05-01|r|2", "2026-05-01|r|3"],
      8,
    );
    expect(out).toEqual([
      { date: "2026-05-01", resourceId: "r", slotIndex: 0, hour: 8, minute: 0 },
      { date: "2026-05-01", resourceId: "r", slotIndex: 1, hour: 8, minute: 30 },
      { date: "2026-05-01", resourceId: "r", slotIndex: 2, hour: 9, minute: 0 },
      { date: "2026-05-01", resourceId: "r", slotIndex: 3, hour: 9, minute: 30 },
    ]);
  });

  it("honors a non-default firstHour", () => {
    const [slot] = expandSlotKeys(["2026-05-01|r|2"], 10);
    // 10 + floor(2/2)=1 → 11:00
    expect(slot).toEqual({
      date: "2026-05-01",
      resourceId: "r",
      slotIndex: 2,
      hour: 11,
      minute: 0,
    });
  });

  it("skips malformed keys (need date|resourceId|slotIndex)", () => {
    const out = expandSlotKeys(
      ["nope", "r|3", "2026-05-01|r|x", "2026-05-01||3", "2026-05-01|good|4"],
      8,
    );
    expect(out).toEqual([
      {
        date: "2026-05-01",
        resourceId: "good",
        slotIndex: 4,
        hour: 10,
        minute: 0,
      },
    ]);
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
