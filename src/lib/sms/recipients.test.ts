import { describe, expect, it } from "vitest";
import {
  normalizeUsPhoneE164,
  selectRecipients,
  type EligibleCoach,
  type ReminderCandidate,
  type ReminderLog,
} from "./recipients";

const HOUR = 60 * 60_000;
// A fixed day window (values are arbitrary epoch-ms; the helpers are pure).
const DAY = Date.UTC(2026, 5, 9, 0, 0, 0);
const block = (coachId: string, programId: string, startHour: number) => {
  const startMs = DAY + startHour * HOUR;
  return {
    blockId: `${coachId}-${programId}-${startHour}`,
    coachId,
    programId,
    startMs,
    endMs: startMs + HOUR,
  } satisfies ReminderCandidate;
};

describe("normalizeUsPhoneE164", () => {
  it("prefixes +1 onto a bare 10-digit US number", () => {
    expect(normalizeUsPhoneE164("4155551234")).toBe("+14155551234");
  });

  it("formats a 10-digit number with punctuation", () => {
    expect(normalizeUsPhoneE164("(415) 555-1234")).toBe("+14155551234");
  });

  it("handles an 11-digit number starting with 1", () => {
    expect(normalizeUsPhoneE164("1-415-555-1234")).toBe("+14155551234");
  });

  it("honors an existing + international form", () => {
    expect(normalizeUsPhoneE164("+44 7700 900123")).toBe("+447700900123");
  });

  it("rejects too-short junk", () => {
    expect(normalizeUsPhoneE164("12345")).toBeNull();
  });

  it("rejects too-long bare digits (not 10 or 11)", () => {
    expect(normalizeUsPhoneE164("123456789012")).toBeNull();
  });

  it("rejects an 11-digit number NOT starting with 1", () => {
    expect(normalizeUsPhoneE164("24155551234")).toBeNull();
  });

  it("rejects letters / empty / null / undefined", () => {
    expect(normalizeUsPhoneE164("call me")).toBeNull();
    expect(normalizeUsPhoneE164("")).toBeNull();
    expect(normalizeUsPhoneE164("   ")).toBeNull();
    expect(normalizeUsPhoneE164(null)).toBeNull();
    expect(normalizeUsPhoneE164(undefined)).toBeNull();
  });

  it("rejects a + form with too few digits", () => {
    expect(normalizeUsPhoneE164("+12")).toBeNull();
  });
});

describe("selectRecipients", () => {
  const eligibleA: EligibleCoach = {
    coachId: "A",
    name: "Coach A",
    phone: "+14155550001",
  };
  const eligibleB: EligibleCoach = {
    coachId: "B",
    name: "Coach B",
    phone: "+14155550002",
  };

  it("texts a coach with an unlogged scheduled block", () => {
    const candidates = [block("A", "p1", 10)];
    const out = selectRecipients({
      candidates,
      logs: [],
      eligible: [eligibleA],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ coachId: "A", phone: "+14155550001" });
  });

  it("does NOT text a coach whose block WAS logged (same program + overlap)", () => {
    const candidates = [block("A", "p1", 10)];
    const logs: ReminderLog[] = [
      { coachId: "A", programId: "p1", startMs: DAY + 10 * HOUR, endMs: DAY + 11 * HOUR },
    ];
    expect(selectRecipients({ candidates, logs, eligible: [eligibleA] })).toEqual(
      [],
    );
  });

  it("texts a coach who logged a DIFFERENT program but missed this block", () => {
    const candidates = [block("A", "p1", 10)];
    const logs: ReminderLog[] = [
      { coachId: "A", programId: "p2", startMs: DAY + 10 * HOUR, endMs: DAY + 11 * HOUR },
    ];
    expect(
      selectRecipients({ candidates, logs, eligible: [eligibleA] }),
    ).toHaveLength(1);
  });

  it("dedupes to ONE entry per coach across multiple unlogged blocks", () => {
    const candidates = [block("A", "p1", 10), block("A", "p2", 14)];
    const out = selectRecipients({
      candidates,
      logs: [],
      eligible: [eligibleA],
    });
    expect(out).toHaveLength(1);
    expect(out[0].coachId).toBe("A");
  });

  it("still texts when ONE of a coach's blocks is logged but another is not", () => {
    const candidates = [block("A", "p1", 10), block("A", "p2", 14)];
    const logs: ReminderLog[] = [
      // p1 block logged, p2 block not.
      { coachId: "A", programId: "p1", startMs: DAY + 10 * HOUR, endMs: DAY + 11 * HOUR },
    ];
    expect(
      selectRecipients({ candidates, logs, eligible: [eligibleA] }),
    ).toHaveLength(1);
  });

  it("excludes a coach who is not eligible (not opted in / no valid phone)", () => {
    const candidates = [block("A", "p1", 10), block("B", "p1", 12)];
    // Only B is eligible.
    const out = selectRecipients({
      candidates,
      logs: [],
      eligible: [eligibleB],
    });
    expect(out).toHaveLength(1);
    expect(out[0].coachId).toBe("B");
  });

  it("returns empty when there are no candidates", () => {
    expect(
      selectRecipients({ candidates: [], logs: [], eligible: [eligibleA] }),
    ).toEqual([]);
  });

  it("handles multiple eligible coaches independently", () => {
    const candidates = [block("A", "p1", 10), block("B", "p1", 12)];
    const logs: ReminderLog[] = [
      // A logged theirs; B did not.
      { coachId: "A", programId: "p1", startMs: DAY + 10 * HOUR, endMs: DAY + 11 * HOUR },
    ];
    const out = selectRecipients({
      candidates,
      logs,
      eligible: [eligibleA, eligibleB],
    });
    expect(out.map((r) => r.coachId)).toEqual(["B"]);
  });
});
