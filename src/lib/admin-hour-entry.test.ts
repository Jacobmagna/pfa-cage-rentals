// Unit tests for the admin hour-entry overlap decision.
//
// The double-pay this guards against is the feature's most expensive
// reachable mistake, and it is reachable by a typo rather than by anything
// unusual — so the boundary cases here are the point, not the happy path.
//
// 🔴 Dates go through `parsePfaInput`, never `new Date("...")`. `hour_logs`
// start/end are `timestamp` WITHOUT time zone, the messages render at PFA
// wall-clock, and the unit suite runs under four timezones.

import { describe, expect, it } from "vitest";
import {
  findOverlappingLogs,
  overlappingLogMessage,
  overlapsWindow,
  type OverlappingLog,
} from "./admin-hour-entry";
import { parsePfaInput } from "./timezone";

const at = (d: string, t: string) => parsePfaInput(d, t);

const log = (over: Partial<OverlappingLog> = {}): OverlappingLog => ({
  id: "l1",
  programName: "Front Desk",
  startAt: at("2026-07-12", "10:00"),
  endAt: at("2026-07-12", "15:00"),
  status: "posted",
  ...over,
});

describe("overlapsWindow", () => {
  const window = {
    startAt: at("2026-07-12", "10:00"),
    endAt: at("2026-07-12", "15:00"),
  };

  it("is true for an identical window", () => {
    expect(overlapsWindow(window, { ...window })).toBe(true);
  });

  // The real double-pay shape: the coach logged 10–3, the admin types 10–2.
  // Neither the unique index nor the duplicate-conflict branch sees this.
  it("is true when one window is contained in the other", () => {
    expect(
      overlapsWindow(window, {
        startAt: at("2026-07-12", "10:00"),
        endAt: at("2026-07-12", "14:00"),
      }),
    ).toBe(true);
  });

  it("is true for a partial overlap at either end", () => {
    expect(
      overlapsWindow(window, {
        startAt: at("2026-07-12", "14:00"),
        endAt: at("2026-07-12", "18:00"),
      }),
    ).toBe(true);
    expect(
      overlapsWindow(window, {
        startAt: at("2026-07-12", "08:00"),
        endAt: at("2026-07-12", "11:00"),
      }),
    ).toBe(true);
  });

  // 🔴 HALF-OPEN, and it must stay that way. A coach working 10–3 and then
  // 3–6 is working two consecutive shifts, which is ordinary and must not
  // warn — warn on it and Mark learns to click through the warning that also
  // fires on the real thing.
  it("is FALSE when the windows merely touch at an endpoint", () => {
    expect(
      overlapsWindow(window, {
        startAt: at("2026-07-12", "15:00"),
        endAt: at("2026-07-12", "18:00"),
      }),
    ).toBe(false);
    expect(
      overlapsWindow(window, {
        startAt: at("2026-07-12", "07:00"),
        endAt: at("2026-07-12", "10:00"),
      }),
    ).toBe(false);
  });

  it("is false for a window on another day", () => {
    expect(
      overlapsWindow(window, {
        startAt: at("2026-07-13", "10:00"),
        endAt: at("2026-07-13", "15:00"),
      }),
    ).toBe(false);
  });

  it("is symmetric", () => {
    const other = {
      startAt: at("2026-07-12", "14:00"),
      endAt: at("2026-07-12", "18:00"),
    };
    expect(overlapsWindow(window, other)).toBe(overlapsWindow(other, window));
  });
});

describe("findOverlappingLogs", () => {
  const window = {
    startAt: at("2026-07-12", "10:00"),
    endAt: at("2026-07-12", "14:00"),
  };

  it("returns nothing when no existing log clashes", () => {
    expect(
      findOverlappingLogs(window, [
        log({ startAt: at("2026-07-13", "10:00"), endAt: at("2026-07-13", "15:00") }),
      ]),
    ).toEqual([]);
  });

  it("finds a clash across a DIFFERENT program", () => {
    // A coach cannot be in two places at once, so the double-pay is just as
    // real across two programs as within one.
    const found = findOverlappingLogs(window, [
      log({ id: "other-program", programName: "Weightlifting" }),
    ]);
    expect(found.map((l) => l.id)).toEqual(["other-program"]);
  });

  it("finds a held log as well as a posted one", () => {
    const found = findOverlappingLogs(window, [log({ status: "held" })]);
    expect(found).toHaveLength(1);
  });

  it("orders the clashes most recent first", () => {
    const found = findOverlappingLogs(window, [
      log({ id: "early", startAt: at("2026-07-12", "09:00"), endAt: at("2026-07-12", "11:00") }),
      log({ id: "late", startAt: at("2026-07-12", "13:00"), endAt: at("2026-07-12", "16:00") }),
    ]);
    expect(found.map((l) => l.id)).toEqual(["late", "early"]);
  });
});

describe("overlappingLogMessage", () => {
  it("names the coach, the program, the date and both times", () => {
    const msg = overlappingLogMessage("Lucas Milone", [log()]);
    expect(msg).toContain("Lucas Milone");
    expect(msg).toContain("Front Desk");
    expect(msg).toContain("Jul 12, 2026");
    expect(msg).toContain("10:00 AM");
    expect(msg).toContain("3:00 PM");
  });

  it("states the consequence in money terms", () => {
    expect(overlappingLogMessage("Lucas Milone", [log()])).toContain(
      "for the same time twice",
    );
  });

  it("says a held clash is not payable YET, and why that still matters", () => {
    const msg = overlappingLogMessage("Lucas Milone", [log({ status: "held" })]);
    expect(msg).toContain("held");
    expect(msg).toContain("approved");
  });

  it("says nothing about approval for a posted clash", () => {
    expect(overlappingLogMessage("Lucas Milone", [log()])).not.toContain(
      "waiting for approval",
    );
  });

  it("counts further clashes, singular and plural", () => {
    const two = overlappingLogMessage("Lucas Milone", [log(), log({ id: "l2" })]);
    expect(two).toContain("1 further entry overlaps");

    const three = overlappingLogMessage("Lucas Milone", [
      log(),
      log({ id: "l2" }),
      log({ id: "l3" }),
    ]);
    expect(three).toContain("2 further entries overlap");
  });

  it("says nothing about further clashes when there is only one", () => {
    expect(overlappingLogMessage("Lucas Milone", [log()])).not.toContain(
      "further",
    );
  });

  // A message with nothing to name would be a warning about no evidence.
  // Failing loudly beats rendering "These hours overlap one already recorded
  // for Lucas Milone: undefined".
  it("throws rather than rendering an empty warning", () => {
    expect(() => overlappingLogMessage("Lucas Milone", [])).toThrow();
  });
});
