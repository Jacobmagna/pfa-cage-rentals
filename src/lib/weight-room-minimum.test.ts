// Unit tests for the weight room one-hour minimum (pure module).
//
// The module has no database and no clock, so every case here is plain
// data in, plain data out. Resource ids are made up; `isWeightRoom` is the
// only thing that says which of them is a weight room.

import { describe, expect, it } from "vitest";
import { totalFromSnapshot } from "@/lib/billing";
import {
  WEIGHT_ROOM_MINIMUM_MINUTES,
  findLoneWeightRoomPicks,
  formatRentalLength,
  isBelowWeightRoomMinimum,
  isPastRentalAdminWaiver,
  mergeContiguousWeightRoomSlots,
} from "./weight-room-minimum";

const WR1 = "weight-room-1";
const WR2 = "weight-room-2";
const CAGE = "cage-1";
const BULLPEN = "bullpen-1";

const isWeightRoom = (resourceId: string) =>
  resourceId === WR1 || resourceId === WR2;

// 2026-11-03 is an arbitrary day; `day` shifts whole days from it.
function at(hour: number, minute = 0, day = 0): Date {
  return new Date(Date.UTC(2026, 10, 3 + day, hour, minute, 0, 0));
}

function slot(
  resourceId: string,
  start: Date,
  end: Date,
  note?: string | null,
) {
  return note === undefined
    ? { resourceId, startAt: start, endAt: end }
    : { resourceId, startAt: start, endAt: end, note };
}

// Reduce a slot list to something `toEqual` can compare without caring
// whether a note is `undefined` or `null`.
function shape(
  slots: ReadonlyArray<{
    resourceId: string;
    startAt: Date;
    endAt: Date;
    note?: string | null;
  }>,
) {
  return slots.map((s) => ({
    resourceId: s.resourceId,
    startAt: s.startAt.toISOString(),
    endAt: s.endAt.toISOString(),
    note: s.note ?? null,
  }));
}

describe("WEIGHT_ROOM_MINIMUM_MINUTES", () => {
  it("is 60", () => {
    expect(WEIGHT_ROOM_MINIMUM_MINUTES).toBe(60);
  });
});

describe("isBelowWeightRoomMinimum", () => {
  it("allows exactly 60 minutes", () => {
    expect(isBelowWeightRoomMinimum(at(15), at(16))).toBe(false);
  });

  it("allows more than 60 minutes (90, 120)", () => {
    expect(isBelowWeightRoomMinimum(at(15), at(16, 30))).toBe(false);
    expect(isBelowWeightRoomMinimum(at(15), at(17))).toBe(false);
  });

  it("refuses 59 minutes", () => {
    expect(isBelowWeightRoomMinimum(at(15), at(15, 59))).toBe(true);
  });

  it("refuses 45 minutes", () => {
    expect(isBelowWeightRoomMinimum(at(15), at(15, 45))).toBe(true);
  });

  it("refuses 30 minutes", () => {
    expect(isBelowWeightRoomMinimum(at(15), at(15, 30))).toBe(true);
  });

  it("refuses 59 minutes and 59.999 seconds (one millisecond short)", () => {
    const start = at(15);
    const end = new Date(at(16).getTime() - 1);
    expect(isBelowWeightRoomMinimum(start, end)).toBe(true);
  });

  it("refuses a zero-length and a backwards range", () => {
    expect(isBelowWeightRoomMinimum(at(15), at(15))).toBe(true);
    expect(isBelowWeightRoomMinimum(at(16), at(15))).toBe(true);
  });

  it("refuses when either time is not a real date (fails closed)", () => {
    expect(isBelowWeightRoomMinimum(new Date(NaN), at(16))).toBe(true);
    expect(isBelowWeightRoomMinimum(at(15), new Date(NaN))).toBe(true);
  });

  it("measures across midnight, not by clock time", () => {
    expect(isBelowWeightRoomMinimum(at(23, 30), at(0, 30, 1))).toBe(false);
    expect(isBelowWeightRoomMinimum(at(23, 30), at(0, 0, 1))).toBe(true);
  });
});

describe("mergeContiguousWeightRoomSlots", () => {
  it("joins two back-to-back slots on the same weight room into one 60-minute slot", () => {
    const merged = mergeContiguousWeightRoomSlots(
      [slot(WR1, at(15), at(15, 30)), slot(WR1, at(15, 30), at(16))],
      isWeightRoom,
    );
    expect(shape(merged)).toEqual([
      {
        resourceId: WR1,
        startAt: at(15).toISOString(),
        endAt: at(16).toISOString(),
        note: null,
      },
    ]);
  });

  it("joins three in a row into one 90-minute slot", () => {
    const merged = mergeContiguousWeightRoomSlots(
      [
        slot(WR1, at(15), at(15, 30)),
        slot(WR1, at(15, 30), at(16)),
        slot(WR1, at(16), at(16, 30)),
      ],
      isWeightRoom,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].startAt.getTime()).toBe(at(15).getTime());
    expect(merged[0].endAt.getTime()).toBe(at(16, 30).getTime());
    expect(
      (merged[0].endAt.getTime() - merged[0].startAt.getTime()) / 60_000,
    ).toBe(90);
  });

  it("gives the same merged result when the input order is scrambled", () => {
    const a = slot(WR1, at(15), at(15, 30), "first");
    const b = slot(WR1, at(15, 30), at(16), "second");
    const c = slot(WR1, at(16), at(16, 30), "third");
    const expected = [
      {
        resourceId: WR1,
        startAt: at(15).toISOString(),
        endAt: at(16, 30).toISOString(),
        note: "first / second / third",
      },
    ];
    for (const order of [
      [a, b, c],
      [a, c, b],
      [b, a, c],
      [b, c, a],
      [c, a, b],
      [c, b, a],
    ]) {
      expect(shape(mergeContiguousWeightRoomSlots(order, isWeightRoom))).toEqual(
        expected,
      );
    }
  });

  it("never merges across two weight rooms, even at adjacent times", () => {
    const input = [
      slot(WR1, at(15), at(15, 30)),
      slot(WR2, at(15, 30), at(16)),
    ];
    const merged = mergeContiguousWeightRoomSlots(input, isWeightRoom);
    expect(shape(merged)).toEqual(shape(input));
  });

  it("never merges two weight rooms at the same time", () => {
    const input = [
      slot(WR1, at(15), at(15, 30)),
      slot(WR2, at(15), at(15, 30)),
    ];
    const merged = mergeContiguousWeightRoomSlots(input, isWeightRoom);
    expect(shape(merged)).toEqual(shape(input));
  });

  it("never merges across a gap (3:00 and 4:00 on the same weight room)", () => {
    const input = [
      slot(WR1, at(15), at(15, 30)),
      slot(WR1, at(16), at(16, 30)),
    ];
    const merged = mergeContiguousWeightRoomSlots(input, isWeightRoom);
    expect(shape(merged)).toEqual(shape(input));
  });

  it("never merges across a one-millisecond gap", () => {
    const input = [
      slot(WR1, at(15), at(15, 30)),
      slot(WR1, new Date(at(15, 30).getTime() + 1), at(16)),
    ];
    const merged = mergeContiguousWeightRoomSlots(input, isWeightRoom);
    expect(merged).toHaveLength(2);
  });

  it("never merges across days (same clock time, next day)", () => {
    const input = [
      slot(WR1, at(15), at(15, 30)),
      slot(WR1, at(15, 30, 1), at(16, 0, 1)),
    ];
    const merged = mergeContiguousWeightRoomSlots(input, isWeightRoom);
    expect(merged).toHaveLength(2);
  });

  it("never merges back-to-back slots on a cage", () => {
    const input = [
      slot(CAGE, at(15), at(15, 30)),
      slot(CAGE, at(15, 30), at(16)),
      slot(CAGE, at(16), at(16, 30)),
    ];
    const merged = mergeContiguousWeightRoomSlots(input, isWeightRoom);
    expect(shape(merged)).toEqual(shape(input));
  });

  it("never merges back-to-back slots on a bullpen", () => {
    const input = [
      slot(BULLPEN, at(15), at(15, 30)),
      slot(BULLPEN, at(15, 30), at(16)),
    ];
    const merged = mergeContiguousWeightRoomSlots(input, isWeightRoom);
    expect(shape(merged)).toEqual(shape(input));
  });

  it("passes cage and bullpen slots through as the very same objects, in their original order", () => {
    const c2 = slot(CAGE, at(16), at(16, 30), "  spaced note  ");
    const b1 = slot(BULLPEN, at(9), at(9, 30));
    const c1 = slot(CAGE, at(15), at(15, 30));
    const merged = mergeContiguousWeightRoomSlots([c2, b1, c1], isWeightRoom);
    expect(merged).toHaveLength(3);
    // Not sorted, not copied, note not trimmed.
    expect(merged[0]).toBe(c2);
    expect(merged[1]).toBe(b1);
    expect(merged[2]).toBe(c1);
  });

  it("leaves a weight room slot with no neighbor exactly as it was (note untouched)", () => {
    const lone = slot(WR1, at(15), at(16), "  keep my spaces  ");
    const merged = mergeContiguousWeightRoomSlots([lone], isWeightRoom);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe(lone);
  });

  it("leaves overlapping weight room slots separate", () => {
    const input = [
      slot(WR1, at(15), at(16)),
      slot(WR1, at(15, 30), at(16, 30)),
    ];
    const merged = mergeContiguousWeightRoomSlots(input, isWeightRoom);
    expect(shape(merged)).toEqual(shape(input));
  });

  it("leaves duplicate weight room slots separate", () => {
    const input = [
      slot(WR1, at(15), at(15, 30)),
      slot(WR1, at(15), at(15, 30)),
    ];
    const merged = mergeContiguousWeightRoomSlots(input, isWeightRoom);
    expect(shape(merged)).toEqual(shape(input));
  });

  it("keeps an overlap visible after merging: a duplicate plus a neighbor still yields two overlapping slots", () => {
    // Two copies of 3:00-3:30 and one 3:30-4:00. Whatever is joined, the
    // result must still contain two slots that overlap, so the caller's
    // overlap check refuses the batch.
    const merged = mergeContiguousWeightRoomSlots(
      [
        slot(WR1, at(15), at(15, 30)),
        slot(WR1, at(15), at(15, 30)),
        slot(WR1, at(15, 30), at(16)),
      ],
      isWeightRoom,
    );
    expect(merged).toHaveLength(2);
    const [x, y] = merged;
    const overlaps =
      x.startAt.getTime() < y.endAt.getTime() &&
      x.endAt.getTime() > y.startAt.getTime();
    expect(overlaps).toBe(true);
  });

  it("never swallows a zero-length slot into a chain", () => {
    const merged = mergeContiguousWeightRoomSlots(
      [
        slot(WR1, at(15), at(15, 30)),
        slot(WR1, at(15, 30), at(15, 30)),
        slot(WR1, at(15, 30), at(16)),
      ],
      isWeightRoom,
    );
    // The zero-length slot must still be there for the database to refuse.
    expect(
      merged.some((s) => s.startAt.getTime() === s.endAt.getTime()),
    ).toBe(true);
  });

  it("merges an off-half-hour seam (3:00-3:45 + 3:45-4:30) to 3:00-4:30", () => {
    const merged = mergeContiguousWeightRoomSlots(
      [slot(WR1, at(15), at(15, 45)), slot(WR1, at(15, 45), at(16, 30))],
      isWeightRoom,
    );
    expect(shape(merged)).toEqual([
      {
        resourceId: WR1,
        startAt: at(15).toISOString(),
        endAt: at(16, 30).toISOString(),
        note: null,
      },
    ]);
  });

  it("an off-half-hour seam bills 3 half-hours merged against 4 apart: never more", () => {
    const rate = 500;
    const parts = [
      slot(WR1, at(15), at(15, 45)),
      slot(WR1, at(15, 45), at(16, 30)),
    ];
    const apart = parts.reduce(
      (sum, s) => sum + totalFromSnapshot(s.startAt, s.endAt, rate),
      0,
    );
    const [merged] = mergeContiguousWeightRoomSlots(parts, isWeightRoom);
    const together = totalFromSnapshot(merged.startAt, merged.endAt, rate);
    expect(apart).toBe(4 * rate);
    expect(together).toBe(3 * rate);
    expect(together).toBeLessThanOrEqual(apart);
  });

  it("on half-hour-aligned slots a merged rental bills exactly the sum of its parts", () => {
    const rate = 500;
    const parts = [
      slot(WR1, at(15), at(15, 30)),
      slot(WR1, at(15, 30), at(16)),
      slot(WR1, at(16), at(16, 30)),
    ];
    const apart = parts.reduce(
      (sum, s) => sum + totalFromSnapshot(s.startAt, s.endAt, rate),
      0,
    );
    const [merged] = mergeContiguousWeightRoomSlots(parts, isWeightRoom);
    expect(totalFromSnapshot(merged.startAt, merged.endAt, rate)).toBe(apart);
    expect(apart).toBe(1500);
  });

  it("merges each weight room on its own when two are picked side by side", () => {
    const merged = mergeContiguousWeightRoomSlots(
      [
        slot(WR1, at(15), at(15, 30)),
        slot(WR2, at(15), at(15, 30)),
        slot(WR1, at(15, 30), at(16)),
        slot(WR2, at(15, 30), at(16)),
      ],
      isWeightRoom,
    );
    expect(shape(merged)).toEqual([
      {
        resourceId: WR1,
        startAt: at(15).toISOString(),
        endAt: at(16).toISOString(),
        note: null,
      },
      {
        resourceId: WR2,
        startAt: at(15).toISOString(),
        endAt: at(16).toISOString(),
        note: null,
      },
    ]);
  });

  it("makes two separate chains on one weight room when there is a gap between them", () => {
    const merged = mergeContiguousWeightRoomSlots(
      [
        slot(WR1, at(15), at(15, 30)),
        slot(WR1, at(15, 30), at(16)),
        slot(WR1, at(17), at(17, 30)),
        slot(WR1, at(17, 30), at(18)),
      ],
      isWeightRoom,
    );
    expect(shape(merged)).toEqual([
      {
        resourceId: WR1,
        startAt: at(15).toISOString(),
        endAt: at(16).toISOString(),
        note: null,
      },
      {
        resourceId: WR1,
        startAt: at(17).toISOString(),
        endAt: at(18).toISOString(),
        note: null,
      },
    ]);
  });

  it("output order: cages stay put, and a merged chain sits where its first-seen member stood", () => {
    const cageA = slot(CAGE, at(9), at(9, 30));
    const cageB = slot(CAGE, at(10), at(10, 30));
    const merged = mergeContiguousWeightRoomSlots(
      [
        cageA,
        // The LATER half of the WR1 chain is seen first...
        slot(WR1, at(15, 30), at(16)),
        cageB,
        // ...then a lone WR2 slot...
        slot(WR2, at(12), at(13)),
        // ...then the EARLIER half of the WR1 chain.
        slot(WR1, at(15), at(15, 30)),
      ],
      isWeightRoom,
    );
    expect(shape(merged)).toEqual([
      shape([cageA])[0],
      {
        resourceId: WR1,
        startAt: at(15).toISOString(),
        endAt: at(16).toISOString(),
        note: null,
      },
      shape([cageB])[0],
      {
        resourceId: WR2,
        startAt: at(12).toISOString(),
        endAt: at(13).toISOString(),
        note: null,
      },
    ]);
  });

  it("does not mutate its input (array, objects or dates)", () => {
    const input = [
      slot(WR1, at(15, 30), at(16), " b "),
      slot(CAGE, at(9), at(9, 30), "cage"),
      slot(WR1, at(15), at(15, 30), "a"),
    ];
    const sameObjects = [...input];
    const before = JSON.stringify(input);
    Object.freeze(input);
    input.forEach((s) => Object.freeze(s));

    const merged = mergeContiguousWeightRoomSlots(input, isWeightRoom);

    expect(JSON.stringify(input)).toBe(before);
    expect(input).toHaveLength(3);
    input.forEach((s, i) => expect(s).toBe(sameObjects[i]));
    // And the merged slot is its own object with its own dates: changing
    // it cannot reach back into the input.
    const mergedWr = merged.find((s) => s.resourceId === WR1)!;
    mergedWr.startAt.setUTCFullYear(1999);
    mergedWr.endAt.setUTCFullYear(1999);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("returns an empty array for an empty input", () => {
    expect(mergeContiguousWeightRoomSlots([], isWeightRoom)).toEqual([]);
  });

  describe("the merged slot's note", () => {
    function mergedNote(notes: Array<string | null | undefined>) {
      // Lay the slots end to end from 3:00 PM in half-hour steps.
      const slots = notes.map((n, i) =>
        slot(
          WR1,
          new Date(at(15).getTime() + i * 30 * 60_000),
          new Date(at(15).getTime() + (i + 1) * 30 * 60_000),
          n,
        ),
      );
      const merged = mergeContiguousWeightRoomSlots(slots, isWeightRoom);
      expect(merged).toHaveLength(1);
      return merged[0].note;
    }

    it("is null when no member has a note", () => {
      expect(mergedNote([undefined, null])).toBeNull();
    });

    it("is null when every note is blank", () => {
      expect(mergedNote(["", "   ", "\n\t"])).toBeNull();
    });

    it("joins the notes with ' / ' in time order", () => {
      expect(mergedNote(["Smith", "Jones"])).toBe("Smith / Jones");
    });

    it("joins in TIME order even when the input order is reversed", () => {
      const merged = mergeContiguousWeightRoomSlots(
        [
          slot(WR1, at(15, 30), at(16), "second"),
          slot(WR1, at(15), at(15, 30), "first"),
        ],
        isWeightRoom,
      );
      expect(merged[0].note).toBe("first / second");
    });

    it("trims each note", () => {
      expect(mergedNote(["  Smith ", "\tJones\n"])).toBe("Smith / Jones");
    });

    it("drops duplicate notes, keeping the first", () => {
      expect(mergedNote(["Smith", "Smith", "Jones", " Smith "])).toBe(
        "Smith / Jones",
      );
    });

    it("skips blank and missing notes between real ones", () => {
      expect(mergedNote(["Smith", "", null, undefined, "  ", "Jones"])).toBe(
        "Smith / Jones",
      );
    });

    it("keeps a single note as it is, trimmed", () => {
      expect(mergedNote([null, "  only one  "])).toBe("only one");
    });

    it("cuts the joined note to 500 characters", () => {
      const a = "a".repeat(300);
      const b = "b".repeat(300);
      const note = mergedNote([a, b]);
      expect(note).toHaveLength(500);
      expect(note).toBe(`${a} / ${b}`.slice(0, 500));
    });

    it("leaves a joined note of exactly 500 characters whole", () => {
      // 248 + 3 (" / ") + 249 = 500
      const a = "a".repeat(248);
      const b = "b".repeat(249);
      expect(mergedNote([a, b])).toBe(`${a} / ${b}`);
      expect(mergedNote([a, b])).toHaveLength(500);
    });
  });
});

describe("findLoneWeightRoomPicks", () => {
  it("returns nothing when every weight room pick makes at least an hour", () => {
    expect(
      findLoneWeightRoomPicks(
        [
          slot(WR1, at(15), at(15, 30)),
          slot(WR1, at(15, 30), at(16)),
          slot(WR2, at(9), at(10)),
        ],
        isWeightRoom,
      ),
    ).toEqual([]);
  });

  it("returns nothing for cages and bullpens, however short", () => {
    expect(
      findLoneWeightRoomPicks(
        [
          slot(CAGE, at(15), at(15, 30)),
          slot(CAGE, at(17), at(17, 30)),
          slot(BULLPEN, at(15), at(15, 15)),
        ],
        isWeightRoom,
      ),
    ).toEqual([]);
  });

  it("returns nothing for an empty selection", () => {
    expect(findLoneWeightRoomPicks([], isWeightRoom)).toEqual([]);
  });

  it("names a single lone 30-minute weight room pick", () => {
    const lone = findLoneWeightRoomPicks(
      [slot(WR1, at(15), at(15, 30))],
      isWeightRoom,
    );
    expect(shape(lone)).toEqual([
      {
        resourceId: WR1,
        startAt: at(15).toISOString(),
        endAt: at(15, 30).toISOString(),
        note: null,
      },
    ]);
  });

  it("names BOTH picks when 3:00 and 4:00 are tapped on the same weight room", () => {
    const lone = findLoneWeightRoomPicks(
      [slot(WR1, at(15), at(15, 30)), slot(WR1, at(16), at(16, 30))],
      isWeightRoom,
    );
    expect(shape(lone).map((s) => s.startAt)).toEqual([
      at(15).toISOString(),
      at(16).toISOString(),
    ]);
  });

  it("names both when adjacent times sit on two different weight rooms", () => {
    const lone = findLoneWeightRoomPicks(
      [slot(WR1, at(15), at(15, 30)), slot(WR2, at(15, 30), at(16))],
      isWeightRoom,
    );
    expect(shape(lone).map((s) => s.resourceId)).toEqual([WR1, WR2]);
  });

  it("names the right slot when picks span two days and two weight rooms", () => {
    const lone = findLoneWeightRoomPicks(
      [
        // Day 0, Weight Room 1: a full hour in two taps → fine.
        slot(WR1, at(15), at(15, 30, 0)),
        slot(WR1, at(15, 30, 0), at(16, 0, 0)),
        // Day 1, Weight Room 1: one tap at the SAME clock time as the
        // second half above, a day later → must not join it.
        slot(WR1, at(15, 30, 1), at(16, 0, 1)),
        // Day 1, Weight Room 2: a full hour in two taps → fine.
        slot(WR2, at(10, 0, 1), at(10, 30, 1)),
        slot(WR2, at(10, 30, 1), at(11, 0, 1)),
        // Day 0, Weight Room 2: one tap → lone.
        slot(WR2, at(10, 0, 0), at(10, 30, 0)),
        // A cage tap on each day → never named.
        slot(CAGE, at(15, 0, 0), at(15, 30, 0)),
        slot(CAGE, at(15, 0, 1), at(15, 30, 1)),
      ],
      isWeightRoom,
    );
    expect(shape(lone)).toEqual([
      {
        resourceId: WR1,
        startAt: at(15, 30, 1).toISOString(),
        endAt: at(16, 0, 1).toISOString(),
        note: null,
      },
      {
        resourceId: WR2,
        startAt: at(10, 0, 0).toISOString(),
        endAt: at(10, 30, 0).toISOString(),
        note: null,
      },
    ]);
  });

  it("does not mutate its input", () => {
    const input = [
      slot(WR1, at(15, 30), at(16), "b"),
      slot(WR1, at(15), at(15, 30), "a"),
      slot(WR2, at(9), at(9, 30)),
    ];
    const before = JSON.stringify(input);
    findLoneWeightRoomPicks(input, isWeightRoom);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("formatRentalLength", () => {
  it("says minutes alone under an hour", () => {
    expect(formatRentalLength(30)).toBe("30 min");
    expect(formatRentalLength(45)).toBe("45 min");
  });

  it("says whole hours alone", () => {
    expect(formatRentalLength(60)).toBe("1 hr");
    expect(formatRentalLength(120)).toBe("2 hr");
  });

  it("says hours and minutes together", () => {
    expect(formatRentalLength(90)).toBe("1 hr 30 min");
    expect(formatRentalLength(150)).toBe("2 hr 30 min");
  });
});

describe("isPastRentalAdminWaiver", () => {
  // "Now" is 4:00 PM on the test day. A rental 3:00-3:30 PM is over; one
  // 3:45-4:15 PM is in progress; one 5:00-5:30 PM is in the future.
  const now = at(16);

  // A 30-minute rental ending at `endAt` (the usual short rental).
  function waived(
    role: "admin" | "coach" | null | undefined,
    endAt: Date,
    when: Date = now,
  ): boolean {
    return isPastRentalAdminWaiver({
      role,
      startAt: new Date(endAt.getTime() - 30 * 60_000),
      endAt,
      now: when,
    });
  }

  it("waives the minimum for an ADMIN when the rental ended before now", () => {
    expect(waived("admin", at(15, 30))).toBe(true);
  });

  it("waives it when the rental ends EXACTLY now (at or before now counts as past)", () => {
    expect(waived("admin", at(16))).toBe(true);
  });

  it("does not waive it when the rental ends one millisecond after now", () => {
    expect(waived("admin", new Date(now.getTime() + 1))).toBe(false);
  });

  it("does not waive it for an admin on a rental in progress or in the future", () => {
    expect(waived("admin", at(16, 15))).toBe(false);
    expect(waived("admin", at(17, 30))).toBe(false);
    expect(waived("admin", at(15, 30, 1))).toBe(false);
  });

  it("judges the END: a rental that started before now but ends after it is not waived", () => {
    expect(
      isPastRentalAdminWaiver({
        role: "admin",
        startAt: at(9),
        endAt: at(16, 30),
        now,
      }),
    ).toBe(false);
  });

  it("never waives it for a coach, a Schedule Manager included (role coach), even on a past rental", () => {
    expect(waived("coach", at(15, 30))).toBe(false);
    expect(waived("coach", at(15, 30, -30))).toBe(false);
  });

  it("never waives it when the role is missing", () => {
    expect(waived(undefined, at(15, 30))).toBe(false);
    expect(waived(null, at(15, 30))).toBe(false);
  });

  it("never waives a past range whose end is not after its start (zero length or backwards)", () => {
    expect(
      isPastRentalAdminWaiver({
        role: "admin",
        startAt: at(15),
        endAt: at(15),
        now,
      }),
    ).toBe(false);
    expect(
      isPastRentalAdminWaiver({
        role: "admin",
        startAt: at(15, 30),
        endAt: at(15),
        now,
      }),
    ).toBe(false);
    // Control: the same past half hour the right way round is waived.
    expect(
      isPastRentalAdminWaiver({
        role: "admin",
        startAt: at(15),
        endAt: at(15, 30),
        now,
      }),
    ).toBe(true);
  });

  it("fails closed when a time or now is not a real date", () => {
    expect(waived("admin", new Date(NaN))).toBe(false);
    expect(waived("admin", at(15, 30), new Date(NaN))).toBe(false);
    expect(
      isPastRentalAdminWaiver({
        role: "admin",
        startAt: new Date(NaN),
        endAt: at(15, 30),
        now,
      }),
    ).toBe(false);
  });

  it("reads the clock it is given, not the real one", () => {
    // A rental far in the real future is "past" against a later `now`, and a
    // rental far in the real past is "future" against an earlier `now`.
    expect(
      waived(
        "admin",
        new Date(Date.UTC(2099, 0, 1, 15, 30)),
        new Date(Date.UTC(2099, 0, 1, 16)),
      ),
    ).toBe(true);
    expect(
      waived(
        "admin",
        new Date(Date.UTC(2001, 0, 1, 15, 30)),
        new Date(Date.UTC(2001, 0, 1, 15)),
      ),
    ).toBe(false);
  });
});
