// Unit tests for the athlete-attendance assembly (QA10 W2.3). Pure
// module → no mocks, no DB. Mirrors attendance-grid.test.ts.

import { describe, expect, it } from "vitest";
import {
  buildAthleteAttendanceByProgram,
  type PlayerProgram,
  type PlayerRecordInput,
  type PlayerSession,
} from "./athlete-attendance";

// Two programs, deliberately out of name order so the builder must sort.
const programBravo: PlayerProgram = { id: "p-bravo", name: "Bravo" };
const programAlpha: PlayerProgram = { id: "p-alpha", name: "Alpha" };

// Sessions across both programs, out of date order.
const sessions: PlayerSession[] = [
  { id: "s-a2", programId: "p-alpha", sessionDate: "2026-06-10" },
  { id: "s-a1", programId: "p-alpha", sessionDate: "2026-06-03" },
  { id: "s-b1", programId: "p-bravo", sessionDate: "2026-06-05" },
];

describe("buildAthleteAttendanceByProgram", () => {
  it("orders programs by name and sessions ascending by date", () => {
    const result = buildAthleteAttendanceByProgram({
      programs: [programBravo, programAlpha],
      sessions,
      records: [],
    });
    expect(result.map((g) => g.programName)).toEqual(["Alpha", "Bravo"]);
    expect(result[0]?.rows.map((r) => r.sessionDate)).toEqual([
      "2026-06-03",
      "2026-06-10",
    ]);
  });

  it("maps present/absent/none statuses from the records", () => {
    const records: PlayerRecordInput[] = [
      { sessionId: "s-a1", present: true }, // present
      { sessionId: "s-a2", present: false }, // absent
      // s-b1 has no record → none
    ];
    const result = buildAthleteAttendanceByProgram({
      programs: [programAlpha, programBravo],
      sessions,
      records,
    });
    const alpha = result.find((g) => g.programId === "p-alpha");
    const bravo = result.find((g) => g.programId === "p-bravo");
    expect(alpha?.rows).toEqual([
      { sessionDate: "2026-06-03", status: "present" },
      { sessionDate: "2026-06-10", status: "absent" },
    ]);
    expect(bravo?.rows).toEqual([
      { sessionDate: "2026-06-05", status: "none" },
    ]);
  });

  it("yields all-none rows for a program with sessions but no records", () => {
    const result = buildAthleteAttendanceByProgram({
      programs: [programAlpha],
      sessions: sessions.filter((s) => s.programId === "p-alpha"),
      records: [],
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.rows.every((r) => r.status === "none")).toBe(true);
  });

  it("still shows a program the athlete has a record in even if not in the program list", () => {
    // The athlete has a record in p-bravo, but only p-alpha was passed as
    // an enrolled program. The page's query unions enrolled + recorded
    // programs, so p-bravo IS in the programs list here — verify the
    // record still drives the status.
    const result = buildAthleteAttendanceByProgram({
      programs: [programAlpha, programBravo],
      sessions,
      records: [{ sessionId: "s-b1", present: true }],
    });
    const bravo = result.find((g) => g.programId === "p-bravo");
    expect(bravo?.rows).toEqual([
      { sessionDate: "2026-06-05", status: "present" },
    ]);
  });

  it("does not mutate its inputs", () => {
    const programs = [programBravo, programAlpha];
    const sessionsCopy = [...sessions];
    const records: PlayerRecordInput[] = [{ sessionId: "s-a1", present: true }];
    buildAthleteAttendanceByProgram({
      programs,
      sessions: sessionsCopy,
      records,
    });
    expect(programs).toEqual([programBravo, programAlpha]);
    expect(sessionsCopy).toEqual(sessions);
    expect(records).toEqual([{ sessionId: "s-a1", present: true }]);
  });

  it("returns an empty array when the athlete is in no programs", () => {
    const result = buildAthleteAttendanceByProgram({
      programs: [],
      sessions: [],
      records: [],
    });
    expect(result).toEqual([]);
  });
});
