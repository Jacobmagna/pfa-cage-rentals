// SPEC rate-effective-dating §7 — the rate-history menu's "…and N entries
// were re-priced" sub-line, under test.
//
// The bug this pins: a DOUBLE SUBMIT. Two overlapping applies each write an
// audit row per (coach, program) group. The second one's UPDATEs correctly
// match nothing — `IS DISTINCT FROM` at the SQL layer sees the rows already
// carry the new stamps — but its audit INSERT is unconditional. Both rows then
// share an entityId, an effectiveFrom and a ts inside the match window, and
// summing them reported "28 entries, +$880.00" for a change that moved 14 and
// $440.00.
//
// No money is involved either way. What is involved is the reversal record:
// someone deciding whether to undo a retro reads this number.

import { describe, expect, it } from "vitest";
import {
  matchReprice,
  REPRICE_MATCH_WINDOW_MS,
  type RepriceAudit,
} from "./rate-history-match";

const EFFECTIVE_FROM = new Date("2026-06-19T07:00:00Z");
const SET_AT = new Date("2026-08-07T18:00:00Z");

function auditRow(over: Partial<RepriceAudit> = {}): RepriceAudit {
  return {
    entityId: "coach-a::prog-1",
    effectiveFromIso: EFFECTIVE_FROM.toISOString(),
    ts: new Date(SET_AT.getTime() + 40),
    logCount: 14,
    deltaCents: 44_000,
    ...over,
  };
}

describe("matchReprice", () => {
  it("sums the groups of one program-default retro", () => {
    // One row per COACH — these must add up, or the menu reports whichever
    // group it happened to see first.
    const rows = [
      auditRow({ entityId: "coach-a::prog-1", logCount: 9, deltaCents: 27_000 }),
      auditRow({ entityId: "coach-b::prog-1", logCount: 5, deltaCents: 17_000 }),
    ];
    expect(matchReprice(rows, EFFECTIVE_FROM, SET_AT)).toEqual({
      logCount: 14,
      deltaCents: 44_000,
    });
  });

  it("🔴 a double submit cannot inflate the count", () => {
    const rows = [
      auditRow({ ts: new Date(SET_AT.getTime() + 40) }),
      // The second apply, 900ms later: same group, same effectiveFrom, wrote
      // no money at all.
      auditRow({ ts: new Date(SET_AT.getTime() + 940) }),
    ];
    expect(matchReprice(rows, EFFECTIVE_FROM, SET_AT)).toEqual({
      logCount: 14,
      deltaCents: 44_000,
    });
  });

  it("dedupes per group, not globally", () => {
    const rows = [
      auditRow({ entityId: "coach-a::prog-1", logCount: 9, deltaCents: 27_000, ts: new Date(SET_AT.getTime() + 40) }),
      auditRow({ entityId: "coach-a::prog-1", logCount: 9, deltaCents: 27_000, ts: new Date(SET_AT.getTime() + 940) }),
      auditRow({ entityId: "coach-b::prog-1", logCount: 5, deltaCents: 17_000, ts: new Date(SET_AT.getTime() + 60) }),
      auditRow({ entityId: "coach-b::prog-1", logCount: 5, deltaCents: 17_000, ts: new Date(SET_AT.getTime() + 960) }),
    ];
    expect(matchReprice(rows, EFFECTIVE_FROM, SET_AT)).toEqual({
      logCount: 14,
      deltaCents: 44_000,
    });
  });

  it("keeps the row NEAREST the rate change, whatever order they arrive in", () => {
    const near = auditRow({ ts: new Date(SET_AT.getTime() + 40), logCount: 14, deltaCents: 44_000 });
    const far = auditRow({ ts: new Date(SET_AT.getTime() + 120_000), logCount: 99, deltaCents: 1 });
    expect(matchReprice([far, near], EFFECTIVE_FROM, SET_AT)?.logCount).toBe(14);
    expect(matchReprice([near, far], EFFECTIVE_FROM, SET_AT)?.logCount).toBe(14);
  });

  it("ignores rows for a different effective date", () => {
    const rows = [
      auditRow({ effectiveFromIso: new Date("2026-07-01T07:00:00Z").toISOString() }),
    ];
    expect(matchReprice(rows, EFFECTIVE_FROM, SET_AT)).toBeNull();
  });

  it("ignores rows written BEFORE the rate change, or outside the window", () => {
    expect(
      matchReprice([auditRow({ ts: new Date(SET_AT.getTime() - 1) })], EFFECTIVE_FROM, SET_AT),
    ).toBeNull();
    expect(
      matchReprice(
        [auditRow({ ts: new Date(SET_AT.getTime() + REPRICE_MATCH_WINDOW_MS + 1) })],
        EFFECTIVE_FROM,
        SET_AT,
      ),
    ).toBeNull();
  });

  it("is null for a going-forward-only change (no effective date)", () => {
    expect(matchReprice([auditRow()], null, SET_AT)).toBeNull();
  });

  it("is null when nothing matches, never a zeroed object", () => {
    expect(matchReprice([], EFFECTIVE_FROM, SET_AT)).toBeNull();
  });
});
