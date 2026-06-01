// Integration tests for the internal attendance-submit mutation logic.
// These hit a real Neon dev branch — see vitest.integration.config.ts
// and tests/integration/setup.ts for env wiring.
//
// We call the INTERNAL function (src/lib/server/attendance-actions.ts)
// directly with a synthetic actor instead of going through the public
// "use server" wrapper. The wrapper adds requireSession() (covered via
// mocked auth elsewhere); calling the internal here lets the test run
// without mocking framework internals — and lets the real
// assertCoachCanAccessProgram run its DB query + redirect.
//
// truncateMutables() does NOT touch programs / coach_programs / athletes
// / athlete_programs / attendance_*, so every test creates its own
// program + athletes with unique ids and scopes assertions to the
// created session/program ids. audit_log IS truncated between tests.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  athletePrograms,
  athletes,
  attendanceRecords,
  attendanceSessions,
  auditLog,
  coachPrograms,
  programs,
} from "@/db/schema";
import { submitAttendanceInternal } from "@/lib/server/attendance-actions";
import {
  AttendanceEmptyRosterError,
  ProgramInactiveError,
} from "@/lib/errors";
import {
  ensureFixtureUsers,
  truncateMutables,
  type FixtureUsers,
} from "./fixtures";

// submitAttendanceInternal → @/lib/authz → @/auth → next-auth, which
// fails to resolve in the vitest node environment. We never exercise
// the real auth() here, so stubbing @/auth is purely to break the
// import chain.
vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

let fixtures: FixtureUsers;

beforeAll(async () => {
  fixtures = await ensureFixtureUsers();
});

beforeEach(async () => {
  await truncateMutables();
});

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const DATE = "2026-05-20";

async function createProgram(active: boolean): Promise<{
  id: string;
  name: string;
}> {
  const name = `Attendance Test Program ${uniqueSuffix()}`;
  const [row] = await db
    .insert(programs)
    .values({ name, active })
    .returning({ id: programs.id, name: programs.name });
  return row;
}

async function createAthlete(): Promise<{ id: string }> {
  const s = uniqueSuffix();
  const [row] = await db
    .insert(athletes)
    .values({ firstName: `First${s}`, lastName: `Last${s}` })
    .returning({ id: athletes.id });
  return row;
}

async function assignAthleteToProgram(
  athleteId: string,
  programId: string,
): Promise<void> {
  await db
    .insert(athletePrograms)
    .values({ athleteId, programId })
    .onConflictDoNothing();
}

async function assignCoach(coachId: string, programId: string): Promise<void> {
  await db
    .insert(coachPrograms)
    .values({ coachId, programId })
    .onConflictDoNothing();
}

async function recordsForSession(sessionId: string) {
  return db
    .select()
    .from(attendanceRecords)
    .where(eq(attendanceRecords.sessionId, sessionId));
}

describe("submitAttendanceInternal", () => {
  it("create: admin submits for a 2-athlete roster → one session, two records, one create audit", async () => {
    const program = await createProgram(true);
    const a1 = await createAthlete();
    const a2 = await createAthlete();
    await assignAthleteToProgram(a1.id, program.id);
    await assignAthleteToProgram(a2.id, program.id);

    const result = await submitAttendanceInternal(fixtures.admin, {
      programId: program.id,
      sessionDate: DATE,
      records: [
        { athleteId: a1.id, present: true },
        { athleteId: a2.id, present: false },
      ],
    });

    expect(result.present).toBe(1);
    expect(result.absent).toBe(1);
    expect(result.total).toBe(2);

    const sessions = await db
      .select()
      .from(attendanceSessions)
      .where(eq(attendanceSessions.programId, program.id));
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(result.sessionId);
    expect(sessions[0].createdBy).toBe(fixtures.admin.id);

    const records = await recordsForSession(result.sessionId);
    expect(records).toHaveLength(2);
    const byAthlete = new Map(records.map((r) => [r.athleteId, r]));
    expect(byAthlete.get(a1.id)?.present).toBe(true);
    expect(byAthlete.get(a2.id)?.present).toBe(false);
    expect(byAthlete.get(a1.id)?.recordedBy).toBe(fixtures.admin.id);

    const audit = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityId, result.sessionId),
          eq(auditLog.entityType, "attendance_session"),
        ),
      );
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe("create");
    expect(audit[0].actorUserId).toBe(fixtures.admin.id);
  });

  it("re-submit (DEC-05): same program+date updates the SAME session, no duplicates, update audit", async () => {
    const program = await createProgram(true);
    const a1 = await createAthlete();
    const a2 = await createAthlete();
    await assignAthleteToProgram(a1.id, program.id);
    await assignAthleteToProgram(a2.id, program.id);

    const first = await submitAttendanceInternal(fixtures.admin, {
      programId: program.id,
      sessionDate: DATE,
      records: [
        { athleteId: a1.id, present: true },
        { athleteId: a2.id, present: false },
      ],
    });

    const second = await submitAttendanceInternal(fixtures.admin, {
      programId: program.id,
      sessionDate: DATE,
      records: [
        { athleteId: a1.id, present: false },
        { athleteId: a2.id, present: true },
      ],
    });

    expect(second.sessionId).toBe(first.sessionId);

    const sessions = await db
      .select()
      .from(attendanceSessions)
      .where(eq(attendanceSessions.programId, program.id));
    expect(sessions).toHaveLength(1);

    const records = await recordsForSession(first.sessionId);
    expect(records).toHaveLength(2);
    const byAthlete = new Map(records.map((r) => [r.athleteId, r]));
    expect(byAthlete.get(a1.id)?.present).toBe(false);
    expect(byAthlete.get(a2.id)?.present).toBe(true);

    const audit = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, first.sessionId));
    expect(audit).toHaveLength(2);
    const actions = audit.map((a) => a.action).sort();
    expect(actions).toEqual(["create", "update"]);
  });

  it("reconcile: foreign athleteId ignored; omitted roster athlete recorded absent", async () => {
    const program = await createProgram(true);
    const onRoster = await createAthlete();
    const omitted = await createAthlete();
    const foreign = await createAthlete(); // never assigned to this program
    await assignAthleteToProgram(onRoster.id, program.id);
    await assignAthleteToProgram(omitted.id, program.id);

    const result = await submitAttendanceInternal(fixtures.admin, {
      programId: program.id,
      sessionDate: DATE,
      records: [
        { athleteId: onRoster.id, present: true },
        // omitted athlete deliberately absent from the records array
        { athleteId: foreign.id, present: true }, // not in roster → ignored
      ],
    });

    expect(result.total).toBe(2);
    expect(result.present).toBe(1);

    const records = await recordsForSession(result.sessionId);
    expect(records).toHaveLength(2);
    const ids = records.map((r) => r.athleteId).sort();
    expect(ids).toEqual([onRoster.id, omitted.id].sort());

    const byAthlete = new Map(records.map((r) => [r.athleteId, r]));
    expect(byAthlete.get(onRoster.id)?.present).toBe(true);
    expect(byAthlete.get(omitted.id)?.present).toBe(false);
    expect(byAthlete.has(foreign.id)).toBe(false);
  });

  it("authz: assigned coach can submit", async () => {
    const program = await createProgram(true);
    const a1 = await createAthlete();
    await assignAthleteToProgram(a1.id, program.id);
    await assignCoach(fixtures.coach.id, program.id);

    const result = await submitAttendanceInternal(fixtures.coach, {
      programId: program.id,
      sessionDate: DATE,
      records: [{ athleteId: a1.id, present: true }],
    });

    expect(result.total).toBe(1);
    const records = await recordsForSession(result.sessionId);
    expect(records[0].recordedBy).toBe(fixtures.coach.id);
  });

  it("authz: unassigned coach is blocked (no session written)", async () => {
    const program = await createProgram(true);
    const a1 = await createAthlete();
    await assignAthleteToProgram(a1.id, program.id);
    // coach NOT assigned → assertCoachCanAccessProgram redirects (throws).

    await expect(
      submitAttendanceInternal(fixtures.coach, {
        programId: program.id,
        sessionDate: DATE,
        records: [{ athleteId: a1.id, present: true }],
      }),
    ).rejects.toBeTruthy();

    const sessions = await db
      .select()
      .from(attendanceSessions)
      .where(eq(attendanceSessions.programId, program.id));
    expect(sessions).toHaveLength(0);
  });

  it("authz: admin can submit for any active program", async () => {
    const program = await createProgram(true);
    const a1 = await createAthlete();
    await assignAthleteToProgram(a1.id, program.id);

    const result = await submitAttendanceInternal(fixtures.admin, {
      programId: program.id,
      sessionDate: DATE,
      records: [{ athleteId: a1.id, present: true }],
    });
    expect(result.sessionId).toBeTruthy();
  });

  it("inactive program → ProgramInactiveError (no session written)", async () => {
    const program = await createProgram(false);
    const a1 = await createAthlete();
    await assignAthleteToProgram(a1.id, program.id);

    await expect(
      submitAttendanceInternal(fixtures.admin, {
        programId: program.id,
        sessionDate: DATE,
        records: [{ athleteId: a1.id, present: true }],
      }),
    ).rejects.toBeInstanceOf(ProgramInactiveError);

    const sessions = await db
      .select()
      .from(attendanceSessions)
      .where(eq(attendanceSessions.programId, program.id));
    expect(sessions).toHaveLength(0);
  });

  it("empty roster → AttendanceEmptyRosterError (no session written)", async () => {
    const program = await createProgram(true);
    const stray = await createAthlete(); // exists but not on the roster

    await expect(
      submitAttendanceInternal(fixtures.admin, {
        programId: program.id,
        sessionDate: DATE,
        records: [{ athleteId: stray.id, present: true }],
      }),
    ).rejects.toBeInstanceOf(AttendanceEmptyRosterError);

    const sessions = await db
      .select()
      .from(attendanceSessions)
      .where(eq(attendanceSessions.programId, program.id));
    expect(sessions).toHaveLength(0);
  });
});
