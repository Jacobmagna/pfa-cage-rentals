// Integration tests for the Phase-1 data foundation (programs, athletes,
// enrollments, hours, attendance).
//
// SAFETY: opens a real DB connection, so it MUST NOT touch production.
// It runs ONLY under `npm run test:integration`, which loads
// tests/integration/setup.ts — that file throws unless
// INTEGRATION_DATABASE_URL is set and DIFFERENT from DATABASE_URL, then
// swaps it in before `@/db` loads. Under the plain `npm run test` (unit)
// config this file is NOT matched (include = src/**), so it never runs
// against the dev/prod branch. The integration branch is assumed already
// migrated (one-time `npm run db:migrate`), per fixtures.ts. As a final
// guard, the suite self-skips when INTEGRATION_DATABASE_URL is unset.

import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import {
  programs,
  athletes,
  athletePrograms,
  attendanceSessions,
  attendanceRecords,
  hourLogs,
} from "@/db/schema";
import { ensureFixtureUsers, type FixtureUsers } from "./fixtures";

const describeIf = process.env.INTEGRATION_DATABASE_URL
  ? describe
  : describe.skip;

describeIf("Phase-1 foundation (integration)", () => {
  // Unique suffix isolates this run from any existing rows on the branch.
  const suffix = `it_${Date.now()}`;
  let users: FixtureUsers;
  let programId: string;
  let athleteId: string;
  let sessionId: string;

  beforeAll(async () => {
    users = await ensureFixtureUsers();
  });

  it("inserts program, athlete, enrollment, session and records", async () => {
    const [program] = await db
      .insert(programs)
      .values({ name: `Program ${suffix}`, cap: 10, capPeriod: "week" })
      .returning();
    programId = program.id;
    expect(program.active).toBe(true);

    const [athlete] = await db
      .insert(athletes)
      .values({ firstName: "Test", lastName: suffix, birthday: "2012-01-01" })
      .returning();
    athleteId = athlete.id;

    await db.insert(athletePrograms).values({ athleteId, programId });

    const [session] = await db
      .insert(attendanceSessions)
      .values({
        programId,
        sessionDate: "2025-05-31",
        createdBy: users.admin.id,
      })
      .returning();
    sessionId = session.id;

    await db.insert(attendanceRecords).values({
      sessionId,
      athleteId,
      present: true,
      recordedBy: users.admin.id,
    });

    const [record] = await db
      .select()
      .from(attendanceRecords)
      .where(eq(attendanceRecords.sessionId, sessionId));
    expect(record.present).toBe(true);
  });

  it("enforces UNIQUE(program_id, session_date) on attendance_sessions", async () => {
    await expect(
      db.insert(attendanceSessions).values({
        programId,
        sessionDate: "2025-05-31",
        createdBy: users.admin.id,
      }),
    ).rejects.toThrow();
  });

  it("enforces CHECK(start_at < end_at) on hour_logs", async () => {
    await expect(
      db.insert(hourLogs).values({
        coachId: users.coach.id,
        programId,
        startAt: new Date("2025-05-31T12:00:00Z"),
        endAt: new Date("2025-05-31T11:00:00Z"),
        createdBy: users.admin.id,
      }),
    ).rejects.toThrow();
  });

  it("enforces CHECK(cap <=> cap_period) on programs (cap without period)", async () => {
    await expect(
      // Drizzle types disallow cap-without-period, so bypass with a cast
      // to drive the raw row past the type system and hit the DB CHECK.
      db
        .insert(programs)
        .values({ name: `Bad ${suffix}`, cap: 5 } as never),
    ).rejects.toThrow();
  });

  it("cascades attendance_records when its session is deleted", async () => {
    await db
      .delete(attendanceSessions)
      .where(eq(attendanceSessions.id, sessionId));
    const remaining = await db
      .select()
      .from(attendanceRecords)
      .where(eq(attendanceRecords.sessionId, sessionId));
    expect(remaining.length).toBe(0);
  });
});
