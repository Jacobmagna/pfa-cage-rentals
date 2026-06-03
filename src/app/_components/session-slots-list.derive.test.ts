import { describe, expect, it } from "vitest";
import { deriveSlots, type SlotInput } from "./session-slots-list";

// deriveSlots is the canonical multi-slot derivation. The coach
// Log-session form runs it in the PARENT so the submitted `slots[]`
// array is always populated from (rangeStart, rangeEnd,
// slotLengthMinutes) — even when the per-session notes editor is
// collapsed. These tests regression-protect the "submit works with
// notes collapsed" guarantee.

const MS_MIN = 60_000;

describe("deriveSlots", () => {
  it("derives N=2 thirty-minute slots for a 1-hour range with empty notes/flags", () => {
    const start = new Date("2026-06-02T14:00:00.000Z");
    const end = new Date("2026-06-02T15:00:00.000Z");

    const slots = deriveSlots(start, end, 30);

    expect(slots).toHaveLength(2);
    // Correct start/end instants, back-to-back.
    expect(slots[0].startAt.getTime()).toBe(start.getTime());
    expect(slots[0].endAt.getTime()).toBe(start.getTime() + 30 * MS_MIN);
    expect(slots[1].startAt.getTime()).toBe(start.getTime() + 30 * MS_MIN);
    expect(slots[1].endAt.getTime()).toBe(end.getTime());
    // Defaults: empty notes, all flags false — so a collapsed-notes
    // submit logs N sessions with null notes / false flags.
    for (const s of slots) {
      expect(s.note).toBe("");
      expect(s.isTeamRental).toBe(false);
      expect(s.pfaReferred).toBe(false);
      expect(s.isOnline).toBe(false);
    }
  });

  it("derives N=2 sixty-minute slots for a 2-hour range", () => {
    const start = new Date("2026-06-02T13:00:00.000Z");
    const end = new Date("2026-06-02T15:00:00.000Z");

    const slots = deriveSlots(start, end, 60);

    expect(slots).toHaveLength(2);
    expect(slots[0].endAt.getTime() - slots[0].startAt.getTime()).toBe(
      60 * MS_MIN,
    );
    expect(slots[1].endAt.getTime()).toBe(end.getTime());
  });

  it("preserves prior notes/flags for slots whose start/end signature is unchanged", () => {
    const start = new Date("2026-06-02T14:00:00.000Z");
    const end = new Date("2026-06-02T15:00:00.000Z");
    const first = deriveSlots(start, end, 30);

    const prior: SlotInput[] = [
      { ...first[0], note: "JP", isOnline: true },
      { ...first[1], note: "drill", pfaReferred: true },
    ];

    const next = deriveSlots(start, end, 30, prior);
    expect(next[0].note).toBe("JP");
    expect(next[0].isOnline).toBe(true);
    expect(next[1].note).toBe("drill");
    expect(next[1].pfaReferred).toBe(true);
  });

  it("returns [] for a null range", () => {
    expect(deriveSlots(null, null, 30)).toEqual([]);
    expect(deriveSlots(new Date(), null, 30)).toEqual([]);
  });

  it("returns [] for a non-positive span", () => {
    const t = new Date("2026-06-02T14:00:00.000Z");
    expect(deriveSlots(t, t, 30)).toEqual([]);
    expect(
      deriveSlots(new Date("2026-06-02T15:00:00.000Z"), t, 30),
    ).toEqual([]);
  });

  it("returns [] for a span that isn't a clean multiple of the slot length", () => {
    const start = new Date("2026-06-02T14:00:00.000Z");
    const end = new Date("2026-06-02T14:45:00.000Z"); // 45 min, not divisible by 30
    expect(deriveSlots(start, end, 30)).toEqual([]);
  });

  it("returns a single slot for an exact one-length range (N=1)", () => {
    const start = new Date("2026-06-02T14:00:00.000Z");
    const end = new Date("2026-06-02T14:30:00.000Z");
    expect(deriveSlots(start, end, 30)).toHaveLength(1);
  });

  it("returns [] when the count would exceed the safe slot limit (>50)", () => {
    const start = new Date("2026-06-02T00:00:00.000Z");
    // 51 * 30 min span.
    const end = new Date(start.getTime() + 51 * 30 * MS_MIN);
    expect(deriveSlots(start, end, 30)).toEqual([]);
  });
});
