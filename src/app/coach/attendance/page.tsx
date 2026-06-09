import { CalendarCheck } from "lucide-react";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
  athletePrograms,
  athletes,
  attendanceRecords,
  attendanceSessions,
  programs,
} from "@/db/schema";
import { requireSession } from "@/lib/authz";
import { formatPfaDate } from "@/lib/timezone";
import {
  ProgramDatePicker,
  type ProgramOption,
} from "./_components/program-date-picker";
import {
  AttendanceForm,
  type RosterAthlete,
} from "./_components/attendance-form";

// Coach attendance page (DEC-24). searchParams-driven (?programId=&date=),
// server-rendered. The picker is a GET <form>; selecting a program + date
// re-renders this page with that program's roster, prefilled from any
// existing attendance session for the day so re-submit edits the same
// session (DEC-05).
//
// Program scoping mirrors /coach/hour-log: every signed-in user sees
// all active programs (DEC-29 — any coach may take attendance for any
// active program).

type RawSearchParams = Promise<{
  programId?: string | string[];
  date?: string | string[];
}>;

function firstParam(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

export default async function CoachAttendancePage({
  searchParams,
}: {
  searchParams: RawSearchParams;
}) {
  await requireSession();
  const params = await searchParams;

  // Every signed-in user gets all active programs (DEC-29).
  const programOptions: ProgramOption[] = await db
    .select({ id: programs.id, name: programs.name })
    .from(programs)
    .where(eq(programs.active, true))
    .orderBy(asc(programs.name));

  const date = firstParam(params.date) || formatPfaDate(new Date());
  const requestedProgramId = firstParam(params.programId);
  const allowedIds = new Set(programOptions.map((p) => p.id));
  const selectedProgramId =
    requestedProgramId && allowedIds.has(requestedProgramId)
      ? requestedProgramId
      : "";

  // Load the roster + prefill marks for the selected program/date.
  let roster: RosterAthlete[] | null = null;
  if (selectedProgramId) {
    const rosterRows = await db
      .select({
        id: athletes.id,
        firstName: athletes.firstName,
        lastName: athletes.lastName,
      })
      .from(athletePrograms)
      .innerJoin(athletes, eq(athletePrograms.athleteId, athletes.id))
      .where(
        and(
          eq(athletePrograms.programId, selectedProgramId),
          // Archived athletes drop off active rosters (DEC-28).
          isNull(athletes.archivedAt),
        ),
      )
      .orderBy(asc(athletes.lastName), asc(athletes.firstName));

    // Existing session for (program, date) → present marks for prefill.
    const presentMap = new Map<string, boolean>();
    const [existingSession] = await db
      .select({ id: attendanceSessions.id })
      .from(attendanceSessions)
      .where(
        and(
          eq(attendanceSessions.programId, selectedProgramId),
          eq(attendanceSessions.sessionDate, date),
        ),
      )
      .limit(1);
    if (existingSession) {
      const records = await db
        .select({
          athleteId: attendanceRecords.athleteId,
          present: attendanceRecords.present,
        })
        .from(attendanceRecords)
        .where(eq(attendanceRecords.sessionId, existingSession.id));
      for (const r of records) presentMap.set(r.athleteId, r.present);
    }

    roster = rosterRows.map((a) => ({
      id: a.id,
      firstName: a.firstName,
      lastName: a.lastName,
      present: presentMap.get(a.id) ?? false,
    }));
  }

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-semibold tracking-tight">Attendance</h1>

      {programOptions.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)] py-16 text-center">
          <CalendarCheck className="h-8 w-8 text-gold" aria-hidden="true" />
          <p className="text-fg-muted">
            No active work yet — ask an admin to add some.
          </p>
        </div>
      ) : (
        <div className="max-w-2xl mx-auto space-y-6">
          <ProgramDatePicker
            programs={programOptions}
            selectedProgramId={selectedProgramId}
            date={date}
          />

          {!selectedProgramId ? (
            <p className="text-sm text-fg-muted">
              Pick work to take attendance.
            </p>
          ) : roster && roster.length > 0 ? (
            <AttendanceForm
              key={`${selectedProgramId}:${date}`}
              programId={selectedProgramId}
              sessionDate={date}
              roster={roster}
            />
          ) : (
            <p className="text-sm text-fg-muted">
              No athletes assigned to this work yet.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
