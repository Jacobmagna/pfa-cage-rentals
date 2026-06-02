// Internal attendance-submit mutation logic. Lives outside any
// "use server" file because Next.js exposes every async export from
// "use server" files as a public RPC endpoint — and this function
// takes the actor as a parameter, so exposing it would let anyone
// forge an admin identity.
//
// The public coach-side server action in
// src/app/coach/attendance/actions.ts wraps this with requireSession().
//
// Pipeline (mirrors logHourInternal + the rate-override upsert):
//   1. Zod-parse                        — submitAttendanceSchema
//   2. Program lookup + active check    — business invariant. Any coach
//      may take attendance for any active program (DEC-29), so there's
//      no per-coach program-access gate here.
//   3. Load current roster (athlete_programs) → reconcile submitted
//      marks against it (DEC-24): ignore foreign athleteIds; default
//      omitted roster athletes to absent. Empty roster → throw.
//   4. Pre-SELECT existing session → decides create-vs-update audit.
//   5. Upsert ONE session per (program, date) (DEC-05) then upsert one
//      record per current-roster athlete. Sequential (neon-http has no
//      transactions).
//   6. ONE audit row per submit — compact summary, never per-record.

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  athletePrograms,
  attendanceRecords,
  attendanceSessions,
  programs,
} from "@/db/schema";
import { type AuthedSession } from "@/lib/authz";
import {
  AttendanceEmptyRosterError,
  ProgramInactiveError,
  ProgramNotFoundError,
} from "@/lib/errors";
import { submitAttendanceSchema } from "@/lib/schemas/attendance";
import { safeLogAudit } from "./audit-helpers";

export type SubmitAttendanceResult = {
  sessionId: string;
  present: number;
  absent: number;
  total: number;
};

export async function submitAttendanceInternal(
  actor: AuthedSession["user"],
  input: unknown,
): Promise<SubmitAttendanceResult> {
  const parsed = submitAttendanceSchema.parse(input);

  // Program must exist + be active.
  const [program] = await db
    .select()
    .from(programs)
    .where(eq(programs.id, parsed.programId))
    .limit(1);
  if (!program) throw new ProgramNotFoundError(parsed.programId);
  if (!program.active) {
    throw new ProgramInactiveError(program.id, program.name);
  }

  // Current roster for this program. We reconcile the submitted marks
  // against this set so client drift / tampering can't write records
  // for athletes who aren't enrolled, and so an athlete the coach
  // didn't tick is recorded absent.
  const rosterRows = await db
    .select({ athleteId: athletePrograms.athleteId })
    .from(athletePrograms)
    .where(eq(athletePrograms.programId, parsed.programId));
  const rosterAthleteIds = rosterRows.map((r) => r.athleteId);
  if (rosterAthleteIds.length === 0) {
    throw new AttendanceEmptyRosterError(parsed.programId);
  }

  const submittedPresent = new Map<string, boolean>();
  for (const rec of parsed.records) {
    submittedPresent.set(rec.athleteId, rec.present);
  }
  // Reconcile to roster: one entry per currently-enrolled athlete.
  // Foreign athleteIds in the submission are ignored (never iterated).
  const effective = rosterAthleteIds.map((athleteId) => ({
    athleteId,
    present: submittedPresent.get(athleteId) ?? false,
  }));

  // Pre-SELECT the existing session so the audit records create vs
  // update and can carry a before-summary.
  const [existingSession] = await db
    .select()
    .from(attendanceSessions)
    .where(
      and(
        eq(attendanceSessions.programId, parsed.programId),
        eq(attendanceSessions.sessionDate, parsed.sessionDate),
      ),
    )
    .limit(1);

  // before-summary (only on update): count present from existing records.
  let before: Record<string, unknown> | undefined;
  if (existingSession) {
    const priorRecords = await db
      .select({ present: attendanceRecords.present })
      .from(attendanceRecords)
      .where(eq(attendanceRecords.sessionId, existingSession.id));
    before = {
      programId: parsed.programId,
      sessionDate: parsed.sessionDate,
      present: priorRecords.filter((r) => r.present).length,
      total: priorRecords.length,
    };
  }

  // Upsert ONE session per (programId, sessionDate). createdBy is set
  // only on insert; on conflict we keep the original creator and just
  // bump updatedAt.
  const [session] = await db
    .insert(attendanceSessions)
    .values({
      programId: parsed.programId,
      sessionDate: parsed.sessionDate,
      createdBy: actor.id,
    })
    .onConflictDoUpdate({
      target: [attendanceSessions.programId, attendanceSessions.sessionDate],
      set: { updatedAt: new Date() },
    })
    .returning();

  // Upsert one record per current-roster athlete. recordedBy is the
  // current submitter on both insert and update. Sequential because
  // neon-http has no transactions.
  for (const { athleteId, present } of effective) {
    await db
      .insert(attendanceRecords)
      .values({
        sessionId: session.id,
        athleteId,
        present,
        recordedBy: actor.id,
      })
      .onConflictDoUpdate({
        target: [attendanceRecords.sessionId, attendanceRecords.athleteId],
        set: { present, recordedBy: actor.id, recordedAt: new Date() },
      });
  }

  const presentCount = effective.filter((e) => e.present).length;
  const total = effective.length;
  const absent = total - presentCount;

  // Exactly ONE audit row per submit — compact summary, never per record.
  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "attendance_session",
    entityId: session.id,
    action: existingSession ? "update" : "create",
    before,
    after: {
      programId: parsed.programId,
      sessionDate: parsed.sessionDate,
      present: presentCount,
      total,
    },
  });

  return { sessionId: session.id, present: presentCount, absent, total };
}
