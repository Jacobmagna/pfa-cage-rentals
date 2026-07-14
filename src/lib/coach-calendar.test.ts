import { describe, expect, it } from "vitest";
import {
  computeSlotState,
  maxConsecutiveFreeSlots,
  selectionToSortedRanges,
  type SlotBlock,
  type SlotSession,
  type SlotState,
} from "./coach-calendar";

// Anchor every slot off a fixed base so the math is plain integers.
// 30-min slot = 1_800_000 ms. We index slots from 0; slot i spans
// [BASE + i*SLOT_MS, BASE + (i+1)*SLOT_MS).
const BASE = 1_000_000_000_000; // arbitrary epoch ms
const SLOT_MS = 30 * 60_000;
const slotStart = (i: number) => BASE + i * SLOT_MS;
const slotEnd = (i: number) => BASE + (i + 1) * SLOT_MS;

function session(
  startSlot: number,
  endSlotExclusive: number,
  opts: {
    coachFirstName?: string;
    isOwn?: boolean;
    sessionId?: string;
    note?: string | null;
    removalPending?: boolean;
    isPast?: boolean;
  } = {},
): SlotSession {
  return {
    startMs: slotStart(startSlot),
    endMs: slotStart(endSlotExclusive),
    coachFirstName: opts.coachFirstName ?? "Mike",
    isOwn: opts.isOwn ?? false,
    sessionId: opts.sessionId ?? "sess-default",
    note: opts.note ?? null,
    removalPending: opts.removalPending ?? false,
    isPast: opts.isPast ?? false,
  };
}

function block(
  startSlot: number,
  endSlotExclusive: number,
  reason = "Maintenance",
): SlotBlock {
  return {
    startMs: slotStart(startSlot),
    endMs: slotStart(endSlotExclusive),
    reason,
  };
}

function stateAt(
  i: number,
  sessions: SlotSession[],
  blocks: SlotBlock[],
): { state: SlotState; occupant: ReturnType<typeof computeSlotState>["occupant"] } {
  return computeSlotState({
    slotStartMs: slotStart(i),
    slotEndMs: slotEnd(i),
    sessions,
    blocks,
  });
}

describe("computeSlotState", () => {
  it("returns free when nothing overlaps the slot", () => {
    const r = stateAt(3, [session(0, 1), session(8, 10)], []);
    expect(r.state).toBe("free");
    expect(r.occupant).toBeNull();
  });

  it("returns own for the coach's own session", () => {
    const r = stateAt(4, [session(4, 6, { coachFirstName: "Sam", isOwn: true })], []);
    expect(r.state).toBe("own");
    expect(r.occupant).toMatchObject({
      kind: "session",
      coachFirstName: "Sam",
      isOwn: true,
    });
  });

  it("carries the session id + own-only note/removalPending on the own occupant (drives the delete/removal popup)", () => {
    const r = stateAt(
      4,
      [
        session(4, 6, {
          isOwn: true,
          sessionId: "sess-42",
          note: "bring L-screen",
          removalPending: true,
          isPast: true,
        }),
      ],
      [],
    );
    expect(r.occupant).toEqual({
      kind: "session",
      coachFirstName: "Mike",
      isOwn: true,
      sessionId: "sess-42",
      note: "bring L-screen",
      removalPending: true,
      isPast: true,
      startMs: slotStart(4),
      endMs: slotStart(6),
    });
  });

  it("returns taken for another coach's session, revealing only first name", () => {
    const r = stateAt(4, [session(4, 6, { coachFirstName: "Mike" })], []);
    expect(r.state).toBe("taken");
    expect(r.occupant).toMatchObject({
      kind: "session",
      coachFirstName: "Mike",
      isOwn: false,
    });
  });

  it("returns blocked for a blocked_time, revealing only the reason", () => {
    const r = stateAt(4, [], [block(3, 5, "Tournament")]);
    expect(r.state).toBe("blocked");
    expect(r.occupant).toEqual({ kind: "block", reason: "Tournament" });
  });

  it("treats a session ending exactly at slot start as NOT occupying (half-open)", () => {
    // session spans slots 2..3 (exclusive end at slot 4 start) → slot 4 free.
    const r = stateAt(4, [session(2, 4)], []);
    expect(r.state).toBe("free");
  });

  it("treats a session starting exactly at slot end as NOT occupying", () => {
    // session starts at slot 5 → slot 4 free.
    const r = stateAt(4, [session(5, 7)], []);
    expect(r.state).toBe("free");
  });

  it("gives a block precedence over an overlapping foreign session", () => {
    const r = stateAt(4, [session(4, 6, { coachFirstName: "Mike" })], [block(4, 5, "Closed")]);
    expect(r.state).toBe("blocked");
    expect(r.occupant).toEqual({ kind: "block", reason: "Closed" });
  });

  it("gives another coach's session precedence over the coach's own", () => {
    const r = stateAt(
      4,
      [
        session(4, 6, { coachFirstName: "Me", isOwn: true }),
        session(4, 6, { coachFirstName: "Mike", isOwn: false }),
      ],
      [],
    );
    expect(r.state).toBe("taken");
    expect(r.occupant).toMatchObject({
      kind: "session",
      coachFirstName: "Mike",
      isOwn: false,
    });
  });

  it("matches own even when own session appears after foreign in the list (foreign still wins)", () => {
    const r = stateAt(
      4,
      [
        session(4, 6, { coachFirstName: "Mike", isOwn: false }),
        session(4, 6, { coachFirstName: "Me", isOwn: true }),
      ],
      [],
    );
    expect(r.state).toBe("taken");
  });
});

describe("maxConsecutiveFreeSlots", () => {
  const TOTAL = 28; // SCHEDULE_GRID_SLOTS

  // Build a slotState accessor from explicit per-index states.
  const accessor = (states: Record<number, SlotState>) => (i: number): SlotState =>
    states[i] ?? "free";

  it("counts the tapped slot itself when it's the only free one (next is taken)", () => {
    expect(
      maxConsecutiveFreeSlots({
        slotIndex: 5,
        totalSlots: TOTAL,
        slotState: accessor({ 6: "taken" }),
      }),
    ).toBe(1);
  });

  it("counts two consecutive free slots, then stops at a taken slot", () => {
    expect(
      maxConsecutiveFreeSlots({
        slotIndex: 5,
        totalSlots: TOTAL,
        slotState: accessor({ 7: "taken" }),
      }),
    ).toBe(2);
  });

  it("counts three consecutive free slots, then stops at a blocked slot", () => {
    expect(
      maxConsecutiveFreeSlots({
        slotIndex: 5,
        totalSlots: TOTAL,
        slotState: accessor({ 8: "blocked" }),
      }),
    ).toBe(3);
  });

  it("stops at the coach's own adjacent session", () => {
    expect(
      maxConsecutiveFreeSlots({
        slotIndex: 5,
        totalSlots: TOTAL,
        slotState: accessor({ 6: "own" }),
      }),
    ).toBe(1);
  });

  it("returns 0 when the tapped slot itself isn't free", () => {
    expect(
      maxConsecutiveFreeSlots({
        slotIndex: 5,
        totalSlots: TOTAL,
        slotState: accessor({ 5: "taken" }),
      }),
    ).toBe(0);
  });

  it("returns 1 on the last slot of the day (nothing after it)", () => {
    expect(
      maxConsecutiveFreeSlots({
        slotIndex: TOTAL - 1,
        totalSlots: TOTAL,
        slotState: accessor({}),
      }),
    ).toBe(1);
  });

  it("returns 2 on the second-to-last slot when both it and the last are free", () => {
    expect(
      maxConsecutiveFreeSlots({
        slotIndex: TOTAL - 2,
        totalSlots: TOTAL,
        slotState: accessor({}),
      }),
    ).toBe(2);
  });

  it("clamps the run at the end of the day even when all remaining slots are free", () => {
    // From slot 25 there are exactly 3 slots left (25, 26, 27).
    expect(
      maxConsecutiveFreeSlots({
        slotIndex: 25,
        totalSlots: TOTAL,
        slotState: accessor({}),
      }),
    ).toBe(3);
  });

  it("counts the full day when every slot is free from index 0", () => {
    expect(
      maxConsecutiveFreeSlots({
        slotIndex: 0,
        totalSlots: TOTAL,
        slotState: accessor({}),
      }),
    ).toBe(TOTAL);
  });
});

describe("selectionToSortedRanges", () => {
  const FIRST_HOUR = 8; // grid starts at 8 AM

  it("returns an empty list for an empty selection", () => {
    expect(selectionToSortedRanges(new Set<number>(), FIRST_HOUR)).toEqual([]);
  });

  it("sorts by slot index (== by time), independent of insertion order", () => {
    // Inserted out of order: 5, 0, 2.
    const set = new Set<number>();
    set.add(5);
    set.add(0);
    set.add(2);
    expect(selectionToSortedRanges(set, FIRST_HOUR)).toEqual([
      { slotIndex: 0, hour: 8, minute: 0 },
      { slotIndex: 2, hour: 9, minute: 0 },
      { slotIndex: 5, hour: 10, minute: 30 },
    ]);
  });

  it("maps even indices to :00 and odd indices to :30, with hour from floor(i/2)", () => {
    expect(selectionToSortedRanges([0, 1, 2, 3], FIRST_HOUR)).toEqual([
      { slotIndex: 0, hour: 8, minute: 0 },
      { slotIndex: 1, hour: 8, minute: 30 },
      { slotIndex: 2, hour: 9, minute: 0 },
      { slotIndex: 3, hour: 9, minute: 30 },
    ]);
  });
});
