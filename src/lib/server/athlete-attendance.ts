// Pure assembly for the admin Attendance "By player" view (QA10 W2.3).
// No DB, no React, no I/O — the page does the set-based reads
// (mirroring by-program/page.tsx) and hands the raw rows here.
// Mirrors the pure-transform + unit-test pattern of attendance-grid.ts.
//
// Goal: for ONE athlete, group their attendance by program. Each group
// lists every session date of that program in date order with a status:
// present / absent (from the athlete's record for that session) or none
// (no record taken for that athlete that session — a blank cell).
//
// Programs are ordered by name; sessions within a program ascending by
// sessionDate (string compare is correct for "YYYY-MM-DD"). Pure — no
// `new Date()`: sessionDate stays text and is never timezone-converted.

export type PlayerProgram = {
  id: string;
  name: string;
};

export type PlayerSession = {
  id: string;
  programId: string;
  sessionDate: string; // "YYYY-MM-DD"
};

export type PlayerRecordInput = {
  sessionId: string;
  present: boolean;
};

export type PlayerAttendanceRow = {
  sessionDate: string;
  status: "present" | "absent" | "none";
};

export type PlayerProgramAttendance = {
  programId: string;
  programName: string;
  rows: PlayerAttendanceRow[];
};

/**
 * Builds the per-program attendance shape for a single athlete. Pure —
 * no side effects, no DB, never mutates its inputs.
 *
 * - Programs ordered by name (locale compare), then id as a tiebreaker.
 * - Within each program, sessions ascending by sessionDate.
 * - status = present/absent from the athlete's record for that session,
 *   or "none" when the athlete has no record for it.
 */
export function buildAthleteAttendanceByProgram(input: {
  programs: PlayerProgram[];
  sessions: PlayerSession[];
  records: PlayerRecordInput[];
}): PlayerProgramAttendance[] {
  // sessionId → present, for this athlete only.
  const presentBySession = new Map<string, boolean>();
  for (const r of input.records) {
    presentBySession.set(r.sessionId, r.present);
  }

  // Dedup programs by id, keep first name seen.
  const programById = new Map<string, PlayerProgram>();
  for (const p of input.programs) {
    if (!programById.has(p.id)) programById.set(p.id, p);
  }

  // Group sessions by programId (copy, don't mutate input).
  const sessionsByProgram = new Map<string, PlayerSession[]>();
  for (const s of input.sessions) {
    const list = sessionsByProgram.get(s.programId);
    if (list) list.push(s);
    else sessionsByProgram.set(s.programId, [s]);
  }

  const result: PlayerProgramAttendance[] = [];
  for (const program of programById.values()) {
    const sessions = (sessionsByProgram.get(program.id) ?? [])
      .slice()
      .sort((a, b) => a.sessionDate.localeCompare(b.sessionDate));

    const rows: PlayerAttendanceRow[] = sessions.map((s) => {
      const present = presentBySession.get(s.id);
      return {
        sessionDate: s.sessionDate,
        status:
          present === true ? "present" : present === false ? "absent" : "none",
      };
    });

    result.push({
      programId: program.id,
      programName: program.name,
      rows,
    });
  }

  result.sort(
    (a, b) =>
      a.programName.localeCompare(b.programName) ||
      a.programId.localeCompare(b.programId),
  );

  return result;
}
