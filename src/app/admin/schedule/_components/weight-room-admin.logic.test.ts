// Unit tests for the weight room choices and copy on the admin screens
// (pure module). Plain data in, plain data out: no database, no clock.

import { describe, expect, it } from "vitest";
import { pfaWallClockToUtc } from "@/lib/timezone";
import {
  WEIGHT_ROOM_RANGE_REFUSAL,
  emptyCellPrefillMinutes,
  weightRoomMoveRefusal,
  weightRoomRangeRefusal,
  weightRoomRangeStatus,
  type WeightRoomViewer,
} from "./weight-room-admin.logic";

// 2026-11-03 is an arbitrary day.
function at(hour: number, minute = 0): Date {
  return new Date(Date.UTC(2026, 10, 3, hour, minute, 0, 0));
}

// For every test that is not about the admin past-rental waiver: an admin
// whose clock reads two days BEFORE the test day, so every test-day range is
// still to come and the one-hour rule applies in full. The clock is passed
// in, never read.
const BEFORE = {
  role: "admin" as const,
  now: new Date(Date.UTC(2026, 10, 1, 12, 0, 0, 0)),
};

describe("WEIGHT_ROOM_RANGE_REFUSAL", () => {
  it("is the same sentence the coach form shows", () => {
    expect(WEIGHT_ROOM_RANGE_REFUSAL).toBe(
      "Weight room rentals are one hour minimum. Make the end time at least 1 hour after the start.",
    );
  });
});

describe("weightRoomRangeStatus (the admin create dialogs, weight room only)", () => {
  it("says nothing while the start or end is not filled in yet", () => {
    expect(weightRoomRangeStatus(null, null, BEFORE)).toEqual({ kind: "incomplete" });
    expect(weightRoomRangeStatus(at(15), null, BEFORE)).toEqual({ kind: "incomplete" });
    expect(weightRoomRangeStatus(null, at(16), BEFORE)).toEqual({ kind: "incomplete" });
  });

  it("refuses 30 minutes", () => {
    expect(weightRoomRangeStatus(at(15), at(15, 30), BEFORE)).toEqual({
      kind: "too-short",
    });
  });

  it("refuses 59 minutes", () => {
    expect(weightRoomRangeStatus(at(15), at(15, 59), BEFORE)).toEqual({
      kind: "too-short",
    });
  });

  it("refuses an end that is not after the start", () => {
    expect(weightRoomRangeStatus(at(15), at(15), BEFORE)).toEqual({ kind: "too-short" });
    expect(weightRoomRangeStatus(at(16), at(15), BEFORE)).toEqual({ kind: "too-short" });
  });

  it("accepts exactly one hour and names its length", () => {
    expect(weightRoomRangeStatus(at(15), at(16), BEFORE)).toEqual({
      kind: "ok",
      length: "1 hr",
    });
  });

  it("accepts longer ranges in the same wording My rentals uses", () => {
    expect(weightRoomRangeStatus(at(15), at(16, 30), BEFORE)).toEqual({
      kind: "ok",
      length: "1 hr 30 min",
    });
    expect(weightRoomRangeStatus(at(15), at(17), BEFORE)).toEqual({
      kind: "ok",
      length: "2 hr",
    });
  });
});

describe("weightRoomMoveRefusal (drag and drop on both grids)", () => {
  const FROM_WEIGHT_ROOM =
    "Weight room rentals are one hour minimum. This rental is 30 min, so it can't be moved there. Open it and make it at least 1 hour first.";
  const FROM_CAGE_OR_BULLPEN =
    "Weight room rentals are one hour minimum. This rental is 30 min, so it can't be moved onto a weight room.";

  it("a 30-minute WEIGHT ROOM rental dropped on a weight room: refused, naming its length, with the advice to make it an hour", () => {
    expect(
      weightRoomMoveRefusal({
        targetIsWeightRoom: true,
        sourceType: "weight_room",
        startAt: at(15),
        endAt: at(15, 30),
        viewer: BEFORE,
      }),
    ).toBe(FROM_WEIGHT_ROOM);
  });

  it("names any length under an hour (45 min)", () => {
    expect(
      weightRoomMoveRefusal({
        targetIsWeightRoom: true,
        sourceType: "weight_room",
        startAt: at(15),
        endAt: at(15, 45),
        viewer: BEFORE,
      }),
    ).toBe(
      "Weight room rentals are one hour minimum. This rental is 45 min, so it can't be moved there. Open it and make it at least 1 hour first.",
    );
  });

  it("a 30-minute CAGE rental dropped on a weight room: refused, with no advice to make it longer", () => {
    expect(
      weightRoomMoveRefusal({
        targetIsWeightRoom: true,
        sourceType: "cage",
        startAt: at(15),
        endAt: at(15, 30),
        viewer: BEFORE,
      }),
    ).toBe(FROM_CAGE_OR_BULLPEN);
  });

  it("a 30-minute BULLPEN rental dropped on a weight room: the same, no advice", () => {
    expect(
      weightRoomMoveRefusal({
        targetIsWeightRoom: true,
        sourceType: "bullpen",
        startAt: at(15),
        endAt: at(15, 30),
        viewer: BEFORE,
      }),
    ).toBe(FROM_CAGE_OR_BULLPEN);
  });

  it("a 45-minute cage rental names its length too", () => {
    expect(
      weightRoomMoveRefusal({
        targetIsWeightRoom: true,
        sourceType: "cage",
        startAt: at(15),
        endAt: at(15, 45),
        viewer: BEFORE,
      }),
    ).toBe(
      "Weight room rentals are one hour minimum. This rental is 45 min, so it can't be moved onto a weight room.",
    );
  });

  it("lets exactly one hour onto a weight room, from any kind of spot", () => {
    for (const sourceType of ["weight_room", "cage", "bullpen"] as const) {
      expect(
        weightRoomMoveRefusal({
          targetIsWeightRoom: true,
          sourceType,
          startAt: at(15),
          endAt: at(16),
          viewer: BEFORE,
        }),
      ).toBeNull();
    }
  });

  it("lets 1 hr 30 min onto a weight room", () => {
    expect(
      weightRoomMoveRefusal({
        targetIsWeightRoom: true,
        sourceType: "weight_room",
        startAt: at(15),
        endAt: at(16, 30),
        viewer: BEFORE,
      }),
    ).toBeNull();
  });

  it("never refuses a drop on a cage or bullpen, however short", () => {
    for (const sourceType of ["weight_room", "cage", "bullpen"] as const) {
      expect(
        weightRoomMoveRefusal({
          targetIsWeightRoom: false,
          sourceType,
          startAt: at(15),
          endAt: at(15, 30),
          viewer: BEFORE,
        }),
      ).toBeNull();
    }
  });
});

describe("emptyCellPrefillMinutes (click on an empty cell, both grids)", () => {
  // The grids have 28 half-hour slots, 8:00 AM (slot 0) to 9:30 PM (slot 27).
  const SLOTS = 28;

  it("prefills an hour on a weight room", () => {
    expect(
      emptyCellPrefillMinutes({ isWeightRoom: true, slotIndex: 0, slotCount: SLOTS }),
    ).toBe(60);
    expect(
      emptyCellPrefillMinutes({ isWeightRoom: true, slotIndex: 14, slotCount: SLOTS }),
    ).toBe(60);
  });

  it("prefills an hour on a weight room at 9:00 PM, which ends exactly at closing", () => {
    expect(
      emptyCellPrefillMinutes({ isWeightRoom: true, slotIndex: 26, slotCount: SLOTS }),
    ).toBe(60);
  });

  it("keeps 30 minutes on a weight room at 9:30 PM, where an hour would run past the grid", () => {
    expect(
      emptyCellPrefillMinutes({ isWeightRoom: true, slotIndex: 27, slotCount: SLOTS }),
    ).toBe(30);
  });

  it("keeps 30 minutes on a cage or bullpen, anywhere", () => {
    expect(
      emptyCellPrefillMinutes({ isWeightRoom: false, slotIndex: 0, slotCount: SLOTS }),
    ).toBe(30);
    expect(
      emptyCellPrefillMinutes({ isWeightRoom: false, slotIndex: 27, slotCount: SLOTS }),
    ).toBe(30);
  });
});

describe("weightRoomRangeRefusal (coach form and both admin create dialogs)", () => {
  // Wall-clock times at the facility on an ordinary day.
  const DAY = "2026-10-17";
  const pfa = (time: string) => pfaWallClockToUtc(DAY, time);
  const LATE =
    "Weight room rentals are one hour minimum, and the last hour starts at 9:00 PM. Pick an earlier start.";

  it("an ordinary short range keeps the existing sentence", () => {
    expect(weightRoomRangeRefusal(pfa("15:00"))).toBe(WEIGHT_ROOM_RANGE_REFUSAL);
    expect(weightRoomRangeRefusal(pfa("08:00"))).toBe(WEIGHT_ROOM_RANGE_REFUSAL);
  });

  it("boundary: a start of exactly 9:00 PM can still make an hour, so the existing sentence", () => {
    expect(weightRoomRangeRefusal(pfa("21:00"))).toBe(WEIGHT_ROOM_RANGE_REFUSAL);
  });

  it("a start of 9:30 PM cannot make an hour before the grid ends at 10:00 PM", () => {
    expect(weightRoomRangeRefusal(pfa("21:30"))).toBe(LATE);
  });

  it("any start after 9:00 PM gets the same sentence", () => {
    expect(weightRoomRangeRefusal(pfa("21:01"))).toBe(LATE);
    expect(weightRoomRangeRefusal(pfa("21:59"))).toBe(LATE);
  });

  it("no start yet: the existing sentence", () => {
    expect(weightRoomRangeRefusal(null)).toBe(WEIGHT_ROOM_RANGE_REFUSAL);
  });
});

describe("the admin past-rental waiver on the admin screens (W5): the same rule as the server", () => {
  // "Now" is 6:00 PM on the test day. 3:00-3:30 PM is over, 5:45-6:15 PM is
  // in progress, 7:00-7:30 PM is still to come.
  const NOW = at(18);
  const ADMIN: WeightRoomViewer = { role: "admin", now: NOW };
  // A Schedule Manager is a coach with the scheduleAdmin flag: role "coach".
  const SCHEDULE_MANAGER: WeightRoomViewer = { role: "coach", now: NOW };

  const FROM_WEIGHT_ROOM =
    "Weight room rentals are one hour minimum. This rental is 30 min, so it can't be moved there. Open it and make it at least 1 hour first.";

  describe("weightRoomRangeStatus (create dialogs)", () => {
    it("admin, 30 minutes that are already over: allowed, one session of 30 min", () => {
      expect(weightRoomRangeStatus(at(15), at(15, 30), ADMIN)).toEqual({
        kind: "ok",
        length: "30 min",
      });
    });

    it("admin, 30 minutes ending exactly now: allowed", () => {
      expect(weightRoomRangeStatus(at(17, 30), at(18), ADMIN)).toEqual({
        kind: "ok",
        length: "30 min",
      });
    });

    it("admin, 30 minutes in progress or still to come: refused", () => {
      expect(weightRoomRangeStatus(at(17, 45), at(18, 15), ADMIN)).toEqual({
        kind: "too-short",
      });
      expect(weightRoomRangeStatus(at(19), at(19, 30), ADMIN)).toEqual({
        kind: "too-short",
      });
    });

    it("Schedule Manager, 30 minutes that are already over: refused", () => {
      expect(
        weightRoomRangeStatus(at(15), at(15, 30), SCHEDULE_MANAGER),
      ).toEqual({ kind: "too-short" });
    });

    it("admin, a past range whose end is not after its start: still refused", () => {
      expect(weightRoomRangeStatus(at(15, 30), at(15), ADMIN)).toEqual({
        kind: "too-short",
      });
      expect(weightRoomRangeStatus(at(15), at(15), ADMIN)).toEqual({
        kind: "too-short",
      });
    });
  });

  describe("weightRoomMoveRefusal (drag on both grids), judged on where it LANDS", () => {
    it("admin drops a 30-minute weight room rental on a time already over: not refused", () => {
      expect(
        weightRoomMoveRefusal({
          targetIsWeightRoom: true,
          sourceType: "weight_room",
          startAt: at(15),
          endAt: at(15, 30),
          viewer: ADMIN,
        }),
      ).toBeNull();
    });

    it("admin drops a 30-minute cage rental on a weight room at a time already over: not refused (the server re-prices a change of kind)", () => {
      expect(
        weightRoomMoveRefusal({
          targetIsWeightRoom: true,
          sourceType: "cage",
          startAt: at(15),
          endAt: at(15, 30),
          viewer: ADMIN,
        }),
      ).toBeNull();
    });

    it("admin drops it on a time in progress or still to come: refused as before", () => {
      expect(
        weightRoomMoveRefusal({
          targetIsWeightRoom: true,
          sourceType: "weight_room",
          startAt: at(17, 45),
          endAt: at(18, 15),
          viewer: ADMIN,
        }),
      ).toBe(FROM_WEIGHT_ROOM);
      expect(
        weightRoomMoveRefusal({
          targetIsWeightRoom: true,
          sourceType: "weight_room",
          startAt: at(19),
          endAt: at(19, 30),
          viewer: ADMIN,
        }),
      ).toBe(FROM_WEIGHT_ROOM);
    });

    it("Schedule Manager drops it on a time already over: refused as before", () => {
      expect(
        weightRoomMoveRefusal({
          targetIsWeightRoom: true,
          sourceType: "weight_room",
          startAt: at(15),
          endAt: at(15, 30),
          viewer: SCHEDULE_MANAGER,
        }),
      ).toBe(FROM_WEIGHT_ROOM);
    });
  });
});
