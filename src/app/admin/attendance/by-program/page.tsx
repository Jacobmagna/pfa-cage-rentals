import { CalendarCheck } from "lucide-react";
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  athletePrograms,
  athletes,
  attendanceRecords,
  attendanceSessions,
  programs,
} from "@/db/schema";
import { requireRole } from "@/lib/authz";
import {
  buildAttendanceGrid,
  type GridAthlete,
} from "@/lib/server/attendance-grid";
import { ProgramPicker, type ProgramOption } from "./_components/program-picker";
import { AttendanceGrid } from "./_components/attendance-grid";

// Admin Attendance-by-Program grid (FEAT-10, DEC-25). Read-only,
// searchParams-driven (?programId=). The picker is a GET <form>;
// choosing a program re-renders this page with that program's grid:
// athletes (rows) × session dates (cols), each cell P / A / blank.
//
// The <h1> "Attendance" + sub-tab nav are rendered by the section
// layout (FEAT-07) — this page renders only the picker + grid (+ states).
//
// Reads are set-based (no N+1), mirroring src/lib/reports/fetch.ts, then
// handed to the pure buildAttendanceGrid. Rows = union(current roster,
// athletes with a record in this program's sessions). Cols = all of the
// program's attendance sessions. A later feature (FEAT-11) layers an
// over-cap red-flag + popover on top — not built here.

type RawSearchParams = Promise<{
  programId?: string | string[];
}>;

function firstParam(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

export default async function AttendanceByProgramPage({
  searchParams,
}: {
  searchParams: RawSearchParams;
}) {
  await requireRole("admin");
  const params = await searchParams;

  // Picker options = active programs only. A selected programId that
  // isn't in this set is treated as no selection (DEC-25).
  const programOptions: ProgramOption[] = await db
    .select({ id: programs.id, name: programs.name })
    .from(programs)
    .where(eq(programs.active, true))
    .orderBy(asc(programs.name));

  const requestedProgramId = firstParam(params.programId);
  const allowedIds = new Set(programOptions.map((p) => p.id));
  const selectedProgramId =
    requestedProgramId && allowedIds.has(requestedProgramId)
      ? requestedProgramId
      : "";

  // No active programs at all → tell the admin to create one first.
  if (programOptions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-line bg-surface py-16 text-center">
        <CalendarCheck className="h-8 w-8 text-gold" aria-hidden="true" />
        <p className="text-fg-muted">Create a program first.</p>
      </div>
    );
  }

  // No selection yet → just the picker + a prompt.
  if (!selectedProgramId) {
    return (
      <div className="space-y-6">
        <ProgramPicker programs={programOptions} selectedProgramId="" />
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-line bg-surface py-16 text-center">
          <CalendarCheck className="h-8 w-8 text-gold" aria-hidden="true" />
          <p className="text-fg-muted">Pick a program to view attendance.</p>
        </div>
      </div>
    );
  }

  // Set-based reads for the selected program.
  // (a) current roster athletes.
  const rosterAthletes = await db
    .select({
      id: athletes.id,
      firstName: athletes.firstName,
      lastName: athletes.lastName,
    })
    .from(athletePrograms)
    .innerJoin(athletes, eq(athletePrograms.athleteId, athletes.id))
    .where(eq(athletePrograms.programId, selectedProgramId));

  // (c) the program's attendance sessions (all of them, ascending).
  const sessionRows = await db
    .select({
      id: attendanceSessions.id,
      sessionDate: attendanceSessions.sessionDate,
    })
    .from(attendanceSessions)
    .where(eq(attendanceSessions.programId, selectedProgramId))
    .orderBy(asc(attendanceSessions.sessionDate));

  const sessionIds = sessionRows.map((s) => s.id);

  // (b) athletes that have a record in this program's sessions, WITH
  // names, and (d) the records themselves — both keyed off the session
  // id set. Only query when the program has sessions (inArray on an
  // empty array is invalid).
  let recordAthletes: GridAthlete[] = [];
  let records: { sessionId: string; athleteId: string; present: boolean }[] =
    [];
  if (sessionIds.length > 0) {
    records = await db
      .select({
        sessionId: attendanceRecords.sessionId,
        athleteId: attendanceRecords.athleteId,
        present: attendanceRecords.present,
      })
      .from(attendanceRecords)
      .where(inArray(attendanceRecords.sessionId, sessionIds));

    recordAthletes = await db
      .selectDistinct({
        id: athletes.id,
        firstName: athletes.firstName,
        lastName: athletes.lastName,
      })
      .from(attendanceRecords)
      .innerJoin(athletes, eq(attendanceRecords.athleteId, athletes.id))
      .where(inArray(attendanceRecords.sessionId, sessionIds));
  }

  // buildAttendanceGrid dedups the roster + record athletes.
  const grid = buildAttendanceGrid({
    athletes: [...rosterAthletes, ...recordAthletes],
    sessions: sessionRows,
    records,
  });

  const empty = grid.sessions.length === 0 || grid.athletes.length === 0;

  return (
    <div className="space-y-6">
      <ProgramPicker
        programs={programOptions}
        selectedProgramId={selectedProgramId}
      />

      {empty ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-line bg-surface py-16 text-center">
          <CalendarCheck className="h-8 w-8 text-gold" aria-hidden="true" />
          <p className="text-fg-muted">
            No attendance recorded for this program yet.
          </p>
        </div>
      ) : (
        <AttendanceGrid grid={grid} />
      )}
    </div>
  );
}
