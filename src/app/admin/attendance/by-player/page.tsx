import { CalendarCheck } from "lucide-react";
import { asc, eq, inArray, isNull } from "drizzle-orm";
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
  buildAthleteAttendanceByProgram,
  type PlayerProgram,
  type PlayerSession,
  type PlayerRecordInput,
} from "@/lib/server/athlete-attendance";
import { formatGridDateWithWeekday } from "@/lib/server/attendance-grid";
import { AthletePicker, type AthleteOption } from "./_components/athlete-picker";

// Admin Attendance "By player" view (QA10 W2.3). Read-only,
// searchParams-driven (?athleteId=). The picker is a GET <form>;
// choosing a player re-renders this page with that player's attendance
// for every session date of each program they're in, grouped by program.
//
// The <h1> "Attendance" + sub-tab nav are rendered by the section
// layout (FEAT-07) — this page renders only the picker + content.
//
// Reads are set-based (no N+1), mirroring by-program/page.tsx, then
// handed to the pure buildAthleteAttendanceByProgram. Programs shown =
// union(current enrollments, any program the athlete has a record in).

type RawSearchParams = Promise<{
  athleteId?: string | string[];
}>;

function firstParam(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

export default async function AttendanceByPlayerPage({
  searchParams,
}: {
  searchParams: RawSearchParams;
}) {
  await requireRole("admin");
  const params = await searchParams;

  // Picker options = non-archived athletes, ordered Last, First. A
  // selected athleteId that isn't in this set is treated as no selection
  // (mirrors by-program's allowed-id guard).
  const athleteOptions: AthleteOption[] = await db
    .select({
      id: athletes.id,
      firstName: athletes.firstName,
      lastName: athletes.lastName,
    })
    .from(athletes)
    .where(isNull(athletes.archivedAt))
    .orderBy(asc(athletes.lastName), asc(athletes.firstName));

  const requestedAthleteId = firstParam(params.athleteId);
  const allowedIds = new Set(athleteOptions.map((a) => a.id));
  const selectedAthleteId =
    requestedAthleteId && allowedIds.has(requestedAthleteId)
      ? requestedAthleteId
      : "";

  const selectedAthlete = athleteOptions.find(
    (a) => a.id === selectedAthleteId,
  );

  // No athletes at all → tell the admin to add a player first.
  if (athleteOptions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-line bg-surface py-16 text-center shadow-[var(--shadow-sm)]">
        <CalendarCheck className="h-8 w-8 text-gold" aria-hidden="true" />
        <p className="text-fg-muted">Add a player first.</p>
      </div>
    );
  }

  // No selection yet → just the picker + a prompt.
  if (!selectedAthleteId) {
    return (
      <div className="space-y-6">
        <AthletePicker athletes={athleteOptions} selectedAthleteId="" />
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-line bg-surface py-16 text-center shadow-[var(--shadow-sm)]">
          <CalendarCheck className="h-8 w-8 text-gold" aria-hidden="true" />
          <p className="text-fg-muted">Pick a player to view attendance.</p>
        </div>
      </div>
    );
  }

  // Set-based reads for the selected athlete.
  // (a) Programs the athlete is currently enrolled in (with name).
  const enrolledPrograms = await db
    .select({ id: programs.id, name: programs.name })
    .from(athletePrograms)
    .innerJoin(programs, eq(athletePrograms.programId, programs.id))
    .where(eq(athletePrograms.athleteId, selectedAthleteId));

  // (b) The athlete's own attendance records (sessionId, present).
  const athleteRecords = await db
    .select({
      sessionId: attendanceRecords.sessionId,
      present: attendanceRecords.present,
    })
    .from(attendanceRecords)
    .where(eq(attendanceRecords.athleteId, selectedAthleteId));

  const recordSessionIds = athleteRecords.map((r) => r.sessionId);

  // (c) Programs the athlete has any record in (so de-enrolled programs
  // with past attendance still show). Resolved from the record sessions.
  let recordedPrograms: PlayerProgram[] = [];
  if (recordSessionIds.length > 0) {
    recordedPrograms = await db
      .selectDistinct({ id: programs.id, name: programs.name })
      .from(attendanceSessions)
      .innerJoin(programs, eq(attendanceSessions.programId, programs.id))
      .where(inArray(attendanceSessions.id, recordSessionIds));
  }

  // Union enrolled + recorded programs (dedup by id; helper also dedups).
  const programById = new Map<string, PlayerProgram>();
  for (const p of [...enrolledPrograms, ...recordedPrograms]) {
    if (!programById.has(p.id)) programById.set(p.id, p);
  }
  const playerPrograms = Array.from(programById.values());
  const programIds = playerPrograms.map((p) => p.id);

  // (d) All attendance sessions for those programs (id, programId, date).
  let sessionRows: PlayerSession[] = [];
  if (programIds.length > 0) {
    sessionRows = await db
      .select({
        id: attendanceSessions.id,
        programId: attendanceSessions.programId,
        sessionDate: attendanceSessions.sessionDate,
      })
      .from(attendanceSessions)
      .where(inArray(attendanceSessions.programId, programIds))
      .orderBy(asc(attendanceSessions.sessionDate));
  }

  const records: PlayerRecordInput[] = athleteRecords.map((r) => ({
    sessionId: r.sessionId,
    present: r.present,
  }));

  const groups = buildAthleteAttendanceByProgram({
    programs: playerPrograms,
    sessions: sessionRows,
    records,
  });

  const hasAnySession = groups.some((g) => g.rows.length > 0);

  return (
    <div className="space-y-6">
      <AthletePicker
        athletes={athleteOptions}
        selectedAthleteId={selectedAthleteId}
      />

      {selectedAthlete ? (
        <h2 className="text-lg font-semibold text-fg">
          {selectedAthlete.lastName}, {selectedAthlete.firstName}
        </h2>
      ) : null}

      {!hasAnySession ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-line bg-surface py-16 text-center shadow-[var(--shadow-sm)]">
          <CalendarCheck className="h-8 w-8 text-gold" aria-hidden="true" />
          <p className="text-fg-muted">
            No attendance recorded for this player yet.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {groups
            .filter((g) => g.rows.length > 0)
            .map((group) => {
              const presentCount = group.rows.filter(
                (r) => r.status === "present",
              ).length;
              return (
                <section
                  key={group.programId}
                  className="rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)]"
                >
                  <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
                    <h3 className="text-sm font-semibold text-fg">
                      {group.programName}
                    </h3>
                    <span className="text-xs text-fg-muted tnum">
                      {presentCount} / {group.rows.length} present
                    </span>
                  </header>
                  <ul className="divide-y divide-line">
                    {group.rows.map((row) => (
                      <li
                        key={`${group.programId}-${row.sessionDate}`}
                        className="flex items-center justify-between gap-3 px-4 py-2.5"
                      >
                        <span
                          className="tnum font-mono text-sm text-fg"
                          title={row.sessionDate}
                        >
                          {formatGridDateWithWeekday(row.sessionDate)}
                        </span>
                        {row.status === "present" ? (
                          <span className="font-mono font-semibold text-success">
                            P
                          </span>
                        ) : row.status === "absent" ? (
                          <span className="font-mono font-semibold text-fg-muted">
                            A
                          </span>
                        ) : (
                          <span
                            className="font-mono text-fg-subtle"
                            aria-label="No record"
                          >
                            —
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
        </div>
      )}
    </div>
  );
}
