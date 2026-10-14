// Unit tests for the weight room booking copy and choices on the coach
// calendar (weight-room-booking.logic.ts).
//
// Every refusal on the two calendar panels is decided in the browser,
// before anything is sent, because a production build strips the message
// from an error a server action throws. So the exact words a coach reads
// live here, and each branch is pinned below.

import { describe, expect, it } from "vitest";
import type { SlotState } from "@/lib/coach-calendar";
import { SCHEDULE_GRID_SLOTS } from "@/lib/schedule-grid-utils";
import { pfaWallClockToUtc } from "@/lib/timezone";
import {
  batchWeightRoomRefusal,
  clampWeightRoomDuration,
  countSavedRentals,
  oneTapNeighborFacts,
  oneTapWeightRoomRefusal,
  weightRoomRentalLines,
  type BatchPick,
} from "./weight-room-booking.logic";

const WR1 = "wr-1";
const WR2 = "wr-2";
const CAGE = "cage-1";
const NAMES: Record<string, string> = {
  [WR1]: "Weight Room 1",
  [WR2]: "Weight Room 2",
  [CAGE]: "Cage 1",
};
const isWeightRoom = (id: string) => id === WR1 || id === WR2;
const resourceName = (id: string) => NAMES[id] ?? "Unknown";

const DAY = "2026-10-17";
const OTHER_DAY = "2026-10-18";

// Slot index → "HH:MM" on the grid (slot 0 = 8:00 AM).
function hhmm(slotIndex: number): string {
  const hour = 8 + Math.floor(slotIndex / 2);
  const minute = (slotIndex % 2) * 30;
  return `${String(hour).padStart(2, "0")}:${minute === 0 ? "00" : "30"}`;
}

function pick(date: string, resourceId: string, slotIndex: number): BatchPick {
  const startAt = pfaWallClockToUtc(date, hhmm(slotIndex));
  return {
    date,
    resourceId,
    slotIndex,
    startAt,
    endAt: new Date(startAt.getTime() + 30 * 60_000),
  };
}

// 3:00 PM is slot 14 on the grid.
const S3PM = 14;

// A state lookup for the displayed day: everything free unless listed.
function states(
  overrides: Record<string, SlotState>,
): (resourceId: string, slotIndex: number) => SlotState {
  return (resourceId, slotIndex) =>
    overrides[`${resourceId}|${slotIndex}`] ?? "free";
}

const FIRST_LINE = "Weight room rentals are one hour minimum.";

describe("clampWeightRoomDuration", () => {
  it("keeps an hour", () => {
    expect(clampWeightRoomDuration(60, 120)).toBe(60);
  });

  it("rounds DOWN to a multiple of 30", () => {
    expect(clampWeightRoomDuration(75, 120)).toBe(60);
    expect(clampWeightRoomDuration(89, 120)).toBe(60);
    expect(clampWeightRoomDuration(95, 120)).toBe(90);
    expect(clampWeightRoomDuration(60.9, 120)).toBe(60);
  });

  it("lifts anything under an hour to 60", () => {
    expect(clampWeightRoomDuration(30, 120)).toBe(60);
    expect(clampWeightRoomDuration(59, 120)).toBe(60);
    expect(clampWeightRoomDuration(0, 120)).toBe(60);
    expect(clampWeightRoomDuration(-5, 120)).toBe(60);
  });

  it("caps at the free run", () => {
    expect(clampWeightRoomDuration(150, 120)).toBe(120);
    expect(clampWeightRoomDuration(90, 90)).toBe(90);
    expect(clampWeightRoomDuration(90, 60)).toBe(60);
  });

  it("treats a non-number as an hour", () => {
    expect(clampWeightRoomDuration(Number.NaN, 120)).toBe(60);
    expect(clampWeightRoomDuration(Number.POSITIVE_INFINITY, 120)).toBe(60);
  });

  it("never goes past the free run, even when that is under an hour", () => {
    expect(clampWeightRoomDuration(60, 30)).toBe(30);
  });
});

describe("oneTapNeighborFacts", () => {
  it("before free, no own neighbor", () => {
    expect(
      oneTapNeighborFacts({
        slotIndex: S3PM,
        totalSlots: SCHEDULE_GRID_SLOTS,
        stateAt: (i) => (i === S3PM + 1 ? "taken" : "free"),
      }),
    ).toEqual({ prevSlotFree: true, nextToOwnRental: false });
  });

  it("the first slot of the day has no free half hour before it", () => {
    expect(
      oneTapNeighborFacts({
        slotIndex: 0,
        totalSlots: SCHEDULE_GRID_SLOTS,
        stateAt: () => "free",
      }),
    ).toEqual({ prevSlotFree: false, nextToOwnRental: false });
  });

  it("own rental after", () => {
    expect(
      oneTapNeighborFacts({
        slotIndex: S3PM,
        totalSlots: SCHEDULE_GRID_SLOTS,
        stateAt: (i) =>
          i === S3PM + 1 ? "own" : i === S3PM - 1 ? "taken" : "free",
      }),
    ).toEqual({ prevSlotFree: false, nextToOwnRental: true });
  });

  it("own rental before", () => {
    expect(
      oneTapNeighborFacts({
        slotIndex: S3PM,
        totalSlots: SCHEDULE_GRID_SLOTS,
        stateAt: (i) =>
          i === S3PM - 1 ? "own" : i === S3PM + 1 ? "blocked" : "free",
      }),
    ).toEqual({ prevSlotFree: false, nextToOwnRental: true });
  });

  it("the last slot of the day looks at nothing after it", () => {
    const seen: number[] = [];
    oneTapNeighborFacts({
      slotIndex: SCHEDULE_GRID_SLOTS - 1,
      totalSlots: SCHEDULE_GRID_SLOTS,
      stateAt: (i) => {
        seen.push(i);
        return "taken";
      },
    });
    expect(seen.every((i) => i >= 0 && i < SCHEDULE_GRID_SLOTS)).toBe(true);
  });
});

describe("oneTapWeightRoomRefusal", () => {
  const startAt = pfaWallClockToUtc(DAY, "15:00");
  const LINE_1 =
    "Weight room rentals are one hour minimum, and only 30 minutes is free from 3:00 PM on Weight Room 1.";

  it("a. the half hour before is free: tap that one instead", () => {
    expect(
      oneTapWeightRoomRefusal({
        resourceName: "Weight Room 1",
        startAt,
        prevSlotFree: true,
        nextToOwnRental: false,
        maxDurationMin: 30,
      }),
    ).toEqual([LINE_1, "Tap 2:30 PM instead to book 2:30 PM – 3:30 PM."]);
  });

  it("a wins over b when both hold", () => {
    expect(
      oneTapWeightRoomRefusal({
        resourceName: "Weight Room 1",
        startAt,
        prevSlotFree: true,
        nextToOwnRental: true,
        maxDurationMin: 30,
      }),
    ).toEqual([LINE_1, "Tap 2:30 PM instead to book 2:30 PM – 3:30 PM."]);
  });

  it("b. next to the coach's own rental", () => {
    expect(
      oneTapWeightRoomRefusal({
        resourceName: "Weight Room 1",
        startAt,
        prevSlotFree: false,
        nextToOwnRental: true,
        maxDurationMin: 30,
      }),
    ).toEqual([
      LINE_1,
      "It sits next to your own rental. If that rental hasn't started yet, you can make it longer on My rentals.",
    ]);
  });

  it("c. otherwise", () => {
    expect(
      oneTapWeightRoomRefusal({
        resourceName: "Weight Room 1",
        startAt,
        prevSlotFree: false,
        nextToOwnRental: false,
        maxDurationMin: 30,
      }),
    ).toEqual([LINE_1, "Pick another time."]);
  });

  // A refresh can show the tapped slot itself is now taken: nothing is free
  // from it, so "only 30 minutes is free" would be wrong.
  describe("nothing free from the tapped slot (maxDurationMin 0)", () => {
    const GONE = "3:00 PM on Weight Room 1 is no longer free.";

    it("says the slot is no longer free, then Pick another time", () => {
      expect(
        oneTapWeightRoomRefusal({
          resourceName: "Weight Room 1",
          startAt,
          prevSlotFree: false,
          nextToOwnRental: false,
          maxDurationMin: 0,
        }),
      ).toEqual([GONE, "Pick another time."]);
    });

    it("suggests nothing else, even when the half hour before is free or an own rental is next to it", () => {
      for (const facts of [
        { prevSlotFree: true, nextToOwnRental: false },
        { prevSlotFree: false, nextToOwnRental: true },
        { prevSlotFree: true, nextToOwnRental: true },
      ]) {
        expect(
          oneTapWeightRoomRefusal({
            resourceName: "Weight Room 1",
            startAt,
            maxDurationMin: 0,
            ...facts,
          }),
        ).toEqual([GONE, "Pick another time."]);
      }
    });
  });
});

describe("batchWeightRoomRefusal", () => {
  const base = {
    isWeightRoom,
    resourceName,
    displayedDate: DAY,
  };

  it("no refusal for a back-to-back pair, and cages are never lone", () => {
    expect(
      batchWeightRoomRefusal({
        ...base,
        rows: [pick(DAY, WR1, S3PM), pick(DAY, WR1, S3PM + 1), pick(DAY, CAGE, 3)],
        slotState: states({}),
      }),
    ).toEqual([]);
  });

  it("a. a pick on a day that is not displayed", () => {
    expect(
      batchWeightRoomRefusal({
        ...base,
        rows: [pick(OTHER_DAY, WR1, S3PM)],
        slotState: states({}),
      }),
    ).toEqual([
      FIRST_LINE,
      "Oct 18, 2026, 3:00 PM on Weight Room 1 is a single half hour. Add the half hour before or after it, or remove it.",
    ]);
  });

  it("b. both neighbors free", () => {
    expect(
      batchWeightRoomRefusal({
        ...base,
        rows: [pick(DAY, WR1, S3PM)],
        slotState: states({}),
      }),
    ).toEqual([
      FIRST_LINE,
      "Oct 17, 2026, 3:00 PM on Weight Room 1 is a single half hour. Add 2:30 PM or 3:30 PM too, or remove it.",
    ]);
  });

  it("c. only the half hour before is free", () => {
    expect(
      batchWeightRoomRefusal({
        ...base,
        rows: [pick(DAY, WR1, S3PM)],
        slotState: states({ [`${WR1}|${S3PM + 1}`]: "taken" }),
      }),
    ).toEqual([
      FIRST_LINE,
      "Oct 17, 2026, 3:00 PM on Weight Room 1 is a single half hour. Add 2:30 PM too, or remove it.",
    ]);
  });

  it("c. only the half hour after is free", () => {
    expect(
      batchWeightRoomRefusal({
        ...base,
        rows: [pick(DAY, WR1, S3PM)],
        slotState: states({ [`${WR1}|${S3PM - 1}`]: "blocked" }),
      }),
    ).toEqual([
      FIRST_LINE,
      "Oct 17, 2026, 3:00 PM on Weight Room 1 is a single half hour. Add 3:30 PM too, or remove it.",
    ]);
  });

  it("c wins over d: one free neighbor and one own neighbor", () => {
    expect(
      batchWeightRoomRefusal({
        ...base,
        rows: [pick(DAY, WR1, S3PM)],
        slotState: states({ [`${WR1}|${S3PM - 1}`]: "own" }),
      }),
    ).toEqual([
      FIRST_LINE,
      "Oct 17, 2026, 3:00 PM on Weight Room 1 is a single half hour. Add 3:30 PM too, or remove it.",
    ]);
  });

  it("the first slot of the day: the half hour before it is off the grid, so not free", () => {
    expect(
      batchWeightRoomRefusal({
        ...base,
        rows: [pick(DAY, WR1, 0)],
        slotState: states({}),
      }),
    ).toEqual([
      FIRST_LINE,
      "Oct 17, 2026, 8:00 AM on Weight Room 1 is a single half hour. Add 8:30 AM too, or remove it.",
    ]);
  });

  it("the last slot of the day: the half hour after it is off the grid, so not free", () => {
    expect(
      batchWeightRoomRefusal({
        ...base,
        rows: [pick(DAY, WR1, SCHEDULE_GRID_SLOTS - 1)],
        slotState: states({}),
      }),
    ).toEqual([
      FIRST_LINE,
      "Oct 17, 2026, 9:30 PM on Weight Room 1 is a single half hour. Add 9:00 PM too, or remove it.",
    ]);
  });

  it("d. a neighbor is the coach's own rental and none is free", () => {
    expect(
      batchWeightRoomRefusal({
        ...base,
        rows: [pick(DAY, WR1, S3PM)],
        slotState: states({
          [`${WR1}|${S3PM - 1}`]: "taken",
          [`${WR1}|${S3PM + 1}`]: "own",
        }),
      }),
    ).toEqual([
      FIRST_LINE,
      "Oct 17, 2026, 3:00 PM on Weight Room 1 is a single half hour. Remove it. If your rental next to it hasn't started yet, you can make that one longer on My rentals.",
    ]);
  });

  it("e. both neighbors taken or blocked", () => {
    expect(
      batchWeightRoomRefusal({
        ...base,
        rows: [pick(DAY, WR1, S3PM)],
        slotState: states({
          [`${WR1}|${S3PM - 1}`]: "taken",
          [`${WR1}|${S3PM + 1}`]: "blocked",
        }),
      }),
    ).toEqual([
      FIRST_LINE,
      "Oct 17, 2026, 3:00 PM on Weight Room 1 is a single half hour. The half hours next to it are taken, so remove it.",
    ]);
  });

  it("e. first slot of the day with the next one taken", () => {
    expect(
      batchWeightRoomRefusal({
        ...base,
        rows: [pick(DAY, WR1, 0)],
        slotState: states({ [`${WR1}|1`]: "taken" }),
      }),
    ).toEqual([
      FIRST_LINE,
      "Oct 17, 2026, 8:00 AM on Weight Room 1 is a single half hour. The half hours next to it are taken, so remove it.",
    ]);
  });

  it("neighbors are read on the pick's own resource only", () => {
    // Weight Room 2 next to the pick is taken; Weight Room 1 is free.
    expect(
      batchWeightRoomRefusal({
        ...base,
        rows: [pick(DAY, WR1, S3PM)],
        slotState: states({
          [`${WR2}|${S3PM - 1}`]: "taken",
          [`${WR2}|${S3PM + 1}`]: "taken",
        }),
      }),
    ).toEqual([
      FIRST_LINE,
      "Oct 17, 2026, 3:00 PM on Weight Room 1 is a single half hour. Add 2:30 PM or 3:30 PM too, or remove it.",
    ]);
  });

  it("one line per lone pick, in date-then-time order", () => {
    expect(
      batchWeightRoomRefusal({
        ...base,
        rows: [
          pick(OTHER_DAY, WR1, 2),
          pick(DAY, WR2, S3PM),
          pick(DAY, WR1, S3PM + 4),
          pick(DAY, WR1, 4),
          pick(DAY, WR1, 5),
          pick(DAY, CAGE, 1),
        ],
        slotState: states({}),
      }),
    ).toEqual([
      FIRST_LINE,
      "Oct 17, 2026, 3:00 PM on Weight Room 2 is a single half hour. Add 2:30 PM or 3:30 PM too, or remove it.",
      "Oct 17, 2026, 5:00 PM on Weight Room 1 is a single half hour. Add 4:30 PM or 5:30 PM too, or remove it.",
      "Oct 18, 2026, 9:00 AM on Weight Room 1 is a single half hour. Add the half hour before or after it, or remove it.",
    ]);
  });

  it("two taps on two different weight rooms do not join", () => {
    const lines = batchWeightRoomRefusal({
      ...base,
      rows: [pick(DAY, WR1, S3PM), pick(DAY, WR2, S3PM + 1)],
      slotState: states({}),
    });
    expect(lines).toHaveLength(3);
  });
});

describe("weightRoomRentalLines", () => {
  const slot = (i: number) => pick(DAY, WR1, i);

  it("a back-to-back pair is one hour", () => {
    expect(weightRoomRentalLines([slot(S3PM), slot(S3PM + 1)])).toEqual([
      "3:00 PM – 4:00 PM (1 hr)",
    ]);
  });

  it("three in a row is an hour and a half", () => {
    expect(
      weightRoomRentalLines([slot(S3PM), slot(S3PM + 1), slot(S3PM + 2)]),
    ).toEqual(["3:00 PM – 4:30 PM (1 hr 30 min)"]);
  });

  it("four in a row is two hours", () => {
    expect(
      weightRoomRentalLines([
        slot(S3PM),
        slot(S3PM + 1),
        slot(S3PM + 2),
        slot(S3PM + 3),
      ]),
    ).toEqual(["3:00 PM – 5:00 PM (2 hr)"]);
  });

  it("a lone pick says it is not enough", () => {
    expect(weightRoomRentalLines([slot(S3PM)])).toEqual([
      "3:00 PM – 3:30 PM (30 min, not enough)",
    ]);
  });

  it("separate rentals are listed in time order, whatever the input order", () => {
    expect(
      weightRoomRentalLines([slot(S3PM + 4), slot(S3PM), slot(S3PM + 1)]),
    ).toEqual(["3:00 PM – 4:00 PM (1 hr)", "5:00 PM – 5:30 PM (30 min, not enough)"]);
  });
});

describe("countSavedRentals", () => {
  it("counts rentals saved, not taps", () => {
    expect(
      countSavedRentals(
        [
          pick(DAY, WR1, S3PM),
          pick(DAY, WR1, S3PM + 1),
          pick(DAY, CAGE, 3),
          pick(DAY, CAGE, 4),
        ],
        isWeightRoom,
      ),
    ).toBe(3);
  });

  it("a lone weight room pick still counts as one", () => {
    expect(countSavedRentals([pick(DAY, WR1, S3PM)], isWeightRoom)).toBe(1);
  });
});
