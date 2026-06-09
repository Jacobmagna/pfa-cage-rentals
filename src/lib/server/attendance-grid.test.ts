// Unit tests for the attendance-grid assembly. Pure module → no mocks,
// no DB. Mirrors src/lib/reports/aggregate.test.ts.

import { describe, expect, it } from "vitest";
import {
  buildAttendanceGrid,
  formatGridDate,
  formatGridDateWithWeekday,
  type GridAthlete,
  type GridRecordInput,
  type GridSession,
} from "./attendance-grid";

// Fixture (DEC-25):
//   - rosterOnly: on the roster, has NO records → all-blank row.
//   - rosterAndRecords: on the roster AND has records.
//   - deRostered: NOT on the roster but has a past record (passed in
//     via the union the page builds) → still appears.
const rosterOnly: GridAthlete = {
  id: "a-roster-only",
  firstName: "Carol",
  lastName: "Adams",
};
const rosterAndRecords: GridAthlete = {
  id: "a-both",
  firstName: "Bob",
  lastName: "Baker",
};
const deRostered: GridAthlete = {
  id: "a-derostered",
  firstName: "Anna",
  lastName: "Baker",
};

// Two sessions provided out of order — builder must sort ascending.
const sessionLater: GridSession = { id: "s-2", sessionDate: "2026-06-10" };
const sessionEarlier: GridSession = { id: "s-1", sessionDate: "2026-06-03" };

describe("buildAttendanceGrid", () => {
  function buildFixture() {
    const records: GridRecordInput[] = [
      { sessionId: "s-1", athleteId: "a-both", present: true },
      { sessionId: "s-2", athleteId: "a-both", present: false },
      // de-rostered athlete only has a record in the earlier session.
      { sessionId: "s-1", athleteId: "a-derostered", present: true },
    ];
    return buildAttendanceGrid({
      // roster union: roster (rosterOnly + rosterAndRecords) concatenated
      // with record-athletes (rosterAndRecords again — a dup — + deRostered).
      athletes: [
        rosterOnly,
        rosterAndRecords,
        rosterAndRecords,
        deRostered,
      ],
      sessions: [sessionLater, sessionEarlier],
      records,
    });
  }

  it("dedups athletes by id and sorts by last then first name", () => {
    const grid = buildFixture();
    // a-both appears once despite being passed twice.
    expect(grid.athletes.map((a) => a.id)).toEqual([
      "a-roster-only", // Adams, Carol
      "a-derostered", // Baker, Anna
      "a-both", // Baker, Bob
    ]);
  });

  it("sorts sessions ascending by sessionDate", () => {
    const grid = buildFixture();
    expect(grid.sessions.map((s) => s.id)).toEqual(["s-1", "s-2"]);
    expect(grid.sessions.map((s) => s.sessionDate)).toEqual([
      "2026-06-03",
      "2026-06-10",
    ]);
  });

  it("records present/absent marks correctly in the lookup", () => {
    const grid = buildFixture();
    expect(grid.present["a-both"]?.["s-1"]).toBe(true);
    expect(grid.present["a-both"]?.["s-2"]).toBe(false);
    expect(grid.present["a-derostered"]?.["s-1"]).toBe(true);
  });

  it("leaves a missing (athlete, session) pair absent (blank cell)", () => {
    const grid = buildFixture();
    // de-rostered athlete has no record in the later session.
    expect(grid.present["a-derostered"]?.["s-2"]).toBeUndefined();
  });

  it("includes the roster-only athlete with no present entries", () => {
    const grid = buildFixture();
    expect(grid.athletes.some((a) => a.id === "a-roster-only")).toBe(true);
    expect(grid.present["a-roster-only"]).toBeUndefined();
  });

  it("still includes a de-rostered athlete who has past records", () => {
    const grid = buildFixture();
    expect(grid.athletes.some((a) => a.id === "a-derostered")).toBe(true);
  });

  it("returns empty arrays for no input", () => {
    const grid = buildAttendanceGrid({
      athletes: [],
      sessions: [],
      records: [],
    });
    expect(grid.athletes).toEqual([]);
    expect(grid.sessions).toEqual([]);
    expect(grid.present).toEqual({});
  });
});

describe("formatGridDate", () => {
  it("formats a YYYY-MM-DD string as 'Mon D' from the parts (no TZ shift)", () => {
    expect(formatGridDate("2026-06-03")).toBe("Jun 3");
    expect(formatGridDate("2026-01-01")).toBe("Jan 1");
    expect(formatGridDate("2026-12-31")).toBe("Dec 31");
  });

  it("returns the input unchanged when it isn't a valid date", () => {
    expect(formatGridDate("nonsense")).toBe("nonsense");
  });
});

describe("formatGridDateWithWeekday", () => {
  it("prefixes the weekday: 'Wed, Jun 3' (2026-06-03 is a Wednesday)", () => {
    expect(formatGridDateWithWeekday("2026-06-03")).toBe("Wed, Jun 3");
    // 2026-06-07 is a Sunday.
    expect(formatGridDateWithWeekday("2026-06-07")).toBe("Sun, Jun 7");
  });

  it("returns the input unchanged when it isn't a valid date", () => {
    expect(formatGridDateWithWeekday("nonsense")).toBe("nonsense");
  });
});
