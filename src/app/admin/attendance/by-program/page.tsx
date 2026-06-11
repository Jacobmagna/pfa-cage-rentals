import Link from "next/link";
import { CalendarCheck, Download } from "lucide-react";
import { and, asc, eq, gte, inArray, isNotNull, lt } from "drizzle-orm";
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
import { computeOverCapFlags } from "@/lib/server/attendance-flags";
import { resolveAttendanceMonth } from "@/lib/attendance/month";
import { ProgramPicker, type ProgramOption } from "./_components/program-picker";
import { AttendanceGrid } from "./_components/attendance-grid";
import { MonthNav } from "../_components/month-nav";

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
  month?: string | string[];
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

  // Selected month (?month=YYYY-MM), defaulting to the current PFA month.
  // Bounds the session query so only this month's day-columns render
  // (QA2 #12/#13 — fixes the unbounded horizontal overflow).
  const monthSel = resolveAttendanceMonth(firstParam(params.month) || undefined);

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
      <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-line bg-surface py-16 text-center shadow-[var(--shadow-sm)]">
        <CalendarCheck className="h-8 w-8 text-gold" aria-hidden="true" />
        <p className="text-fg-muted">Create work first.</p>
      </div>
    );
  }

  // No selection yet → just the picker + a prompt.
  if (!selectedProgramId) {
    return (
      <div className="space-y-6">
        <ProgramPicker
          programs={programOptions}
          selectedProgramId=""
          month={monthSel.month}
        />
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-line bg-surface py-16 text-center shadow-[var(--shadow-sm)]">
          <CalendarCheck className="h-8 w-8 text-gold" aria-hidden="true" />
          <p className="text-fg-muted">Pick work to view attendance.</p>
        </div>
      </div>
    );
  }

  // Per-athlete enrollment caps for this program (FEAT-11 redesign).
  // cap + capPeriod are co-required (both NULL = that enrollment is
  // uncapped — filtered out here). Build a capsByAthlete lookup for the
  // pure flag logic. All caps are NULL until the assign-form UI lands, so
  // this currently yields no flags (correct).
  const capRows = await db
    .select({
      athleteId: athletePrograms.athleteId,
      cap: athletePrograms.cap,
      capPeriod: athletePrograms.capPeriod,
    })
    .from(athletePrograms)
    .where(
      and(
        eq(athletePrograms.programId, selectedProgramId),
        isNotNull(athletePrograms.cap),
      ),
    );
  const capsByAthlete: Record<
    string,
    { cap: number; capPeriod: "week" | "month" | "total" }
  > = {};
  for (const row of capRows) {
    if (row.cap == null || row.capPeriod == null) continue;
    capsByAthlete[row.athleteId] = { cap: row.cap, capPeriod: row.capPeriod };
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

  // (c) the program's attendance sessions WITHIN the selected month
  // only, ascending. sessionDate is a "YYYY-MM-DD" string, so the month
  // bound is a string range [firstDay, nextMonthFirstDay).
  const sessionRows = await db
    .select({
      id: attendanceSessions.id,
      sessionDate: attendanceSessions.sessionDate,
    })
    .from(attendanceSessions)
    .where(
      and(
        eq(attendanceSessions.programId, selectedProgramId),
        gte(attendanceSessions.sessionDate, monthSel.firstDay),
        lt(attendanceSessions.sessionDate, monthSel.nextMonthFirstDay),
      ),
    )
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

  // Over-cap red flags (FEAT-11). Pure logic on the already-built grid;
  // athletes without an enrollment cap → no flags → grid renders exactly
  // as FEAT-10.
  const flags = computeOverCapFlags({
    athletes: grid.athletes,
    sessions: grid.sessions,
    present: grid.present,
    capsByAthlete,
  });

  const empty = grid.sessions.length === 0 || grid.athletes.length === 0;

  const downloadHref = `/admin/attendance/download?${new URLSearchParams({
    programId: selectedProgramId,
    month: monthSel.month,
  }).toString()}`;

  return (
    <div className="space-y-6">
      <ProgramPicker
        programs={programOptions}
        selectedProgramId={selectedProgramId}
        month={monthSel.month}
      />

      <MonthNav
        basePath="/admin/attendance/by-program"
        label={monthSel.label}
        prevMonth={monthSel.prevMonth}
        nextMonth={monthSel.nextMonth}
        extraParams={{ programId: selectedProgramId }}
      />

      <div className="flex items-center justify-end">
        <Link
          href={downloadHref}
          prefetch={false}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-4 h-9 text-sm font-medium text-fg-muted shadow-[var(--shadow-sm)] hover:text-fg hover:-translate-y-px hover:shadow-[var(--shadow-md)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition"
        >
          <Download className="h-4 w-4" />
          Download Excel
        </Link>
      </div>

      {empty ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-line bg-surface py-16 text-center shadow-[var(--shadow-sm)]">
          <CalendarCheck className="h-8 w-8 text-gold" aria-hidden="true" />
          <p className="text-fg-muted">
            No attendance recorded for this work this month.
          </p>
        </div>
      ) : (
        <AttendanceGrid grid={grid} flags={flags} />
      )}
    </div>
  );
}
