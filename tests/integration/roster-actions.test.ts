// Integration tests for the internal roster mutation logic
// (src/lib/server/athlete-actions.ts). These hit a real Neon dev branch
// — see vitest.integration.config.ts and tests/integration/setup.ts.
//
// We call the INTERNAL functions directly with a synthetic admin actor
// instead of going through the public "use server" wrappers in
// src/app/admin/attendance/roster/actions.ts. The wrappers add a single
// line — requireRole("admin") — covered separately; calling internals
// here lets the test run without mocking framework internals.
//
// truncateMutables() does NOT touch programs / athletes /
// athlete_programs / attendance_sessions / attendance_records, so every
// test creates rows with unique-suffix names and scopes its assertions
// to the created ids. audit_log IS truncated between tests.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  athletePrograms,
  athletes,
  attendanceRecords,
  attendanceSessions,
  auditLog,
  programs,
} from "@/db/schema";
import {
  assignAthletesToProgramInternal,
  createAthleteInternal,
  deleteAthleteInternal,
  updateAthleteInternal,
} from "@/lib/server/athlete-actions";
import {
  AthleteHasRecordsError,
  AthleteNotFoundError,
  ProgramInactiveError,
  ProgramNotFoundError,
} from "@/lib/errors";
import {
  ensureFixtureUsers,
  truncateMutables,
  type FixtureUsers,
} from "./fixtures";

// athlete-actions → @/lib/authz → @/auth → next-auth, which fails to
// resolve in the vitest node environment. We never exercise real auth()
// here (synthetic actor), so stubbing @/auth just breaks that chain.
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

async function createProgram(
  active = true,
): Promise<{ id: string; name: string }> {
  const name = `Roster Test Program ${uniqueSuffix()}`;
  const [row] = await db
    .insert(programs)
    .values({ name, active })
    .returning({ id: programs.id, name: programs.name });
  return row;
}

describe("createAthleteInternal", () => {
  it("inserts the athlete and writes an athlete/create audit row", async () => {
    const created = await createAthleteInternal(fixtures.admin, {
      firstName: "Ada",
      lastName: `Lovelace-${uniqueSuffix()}`,
      birthday: "2010-12-10",
    });

    expect(created.id).toBeTruthy();
    expect(created.firstName).toBe("Ada");
    expect(created.birthday).toBe("2010-12-10");

    const [row] = await db
      .select()
      .from(athletes)
      .where(eq(athletes.id, created.id));
    expect(row).toBeTruthy();

    const audit = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.entityId, created.id), eq(auditLog.action, "create")),
      );
    expect(audit).toHaveLength(1);
    expect(audit[0].entityType).toBe("athlete");
    expect(audit[0].actorUserId).toBe(fixtures.admin.id);
    const diff = audit[0].diff as { after: Record<string, unknown> };
    expect(diff.after.firstName).toBe("Ada");
  });
});

describe("updateAthleteInternal", () => {
  it("edits the row and audits a changed-keys-only before/after diff", async () => {
    const created = await createAthleteInternal(fixtures.admin, {
      firstName: "Grace",
      lastName: `Hopper-${uniqueSuffix()}`,
      birthday: "2009-01-02",
    });

    const updated = await updateAthleteInternal(fixtures.admin, created.id, {
      firstName: "Grace",
      lastName: created.lastName,
      birthday: "2009-03-04",
    });

    expect(updated.birthday).toBe("2009-03-04");

    const audit = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.entityId, created.id), eq(auditLog.action, "update")),
      );
    expect(audit).toHaveLength(1);
    const diff = audit[0].diff as {
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    };
    expect(diff.before.birthday).toBe("2009-01-02");
    expect(diff.after.birthday).toBe("2009-03-04");
    // firstName didn't change → must not appear in the diff.
    expect(diff.before).not.toHaveProperty("firstName");
  });

  it("throws AthleteNotFoundError for a missing id", async () => {
    await expect(
      updateAthleteInternal(fixtures.admin, "does-not-exist", {
        firstName: "X",
        lastName: "Y",
      }),
    ).rejects.toBeInstanceOf(AthleteNotFoundError);
  });
});

describe("deleteAthleteInternal", () => {
  it("deletes an athlete with no records and audits the before snapshot", async () => {
    const created = await createAthleteInternal(fixtures.admin, {
      firstName: "Del",
      lastName: `Eted-${uniqueSuffix()}`,
    });

    await deleteAthleteInternal(fixtures.admin, created.id);

    const remaining = await db
      .select()
      .from(athletes)
      .where(eq(athletes.id, created.id));
    expect(remaining).toHaveLength(0);

    const audit = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.entityId, created.id), eq(auditLog.action, "delete")),
      );
    expect(audit).toHaveLength(1);
    const diff = audit[0].diff as { before: Record<string, unknown> };
    expect(diff.before.id).toBe(created.id);
    expect(diff.before.firstName).toBe("Del");
  });

  it("throws AthleteHasRecordsError when the athlete has an attendance record", async () => {
    const program = await createProgram();
    const created = await createAthleteInternal(fixtures.admin, {
      firstName: "Has",
      lastName: `Records-${uniqueSuffix()}`,
    });

    // Inline attendance fixtures: a session for the program + a record
    // for this athlete.
    const [session] = await db
      .insert(attendanceSessions)
      .values({
        programId: program.id,
        sessionDate: "2026-05-01",
        createdBy: fixtures.admin.id,
      })
      .returning({ id: attendanceSessions.id });
    await db.insert(attendanceRecords).values({
      sessionId: session.id,
      athleteId: created.id,
      present: true,
      recordedBy: fixtures.admin.id,
    });

    await expect(
      deleteAthleteInternal(fixtures.admin, created.id),
    ).rejects.toBeInstanceOf(AthleteHasRecordsError);

    // The athlete must still exist (not deleted).
    const still = await db
      .select()
      .from(athletes)
      .where(eq(athletes.id, created.id));
    expect(still).toHaveLength(1);

    // Clean up: records cascade when the session is gone; remove the
    // record/session/athlete so we don't leak into other suites.
    await db
      .delete(attendanceRecords)
      .where(eq(attendanceRecords.athleteId, created.id));
    await db
      .delete(attendanceSessions)
      .where(eq(attendanceSessions.id, session.id));
    await db.delete(athletes).where(eq(athletes.id, created.id));
  });

  it("throws AthleteNotFoundError for a missing id", async () => {
    await expect(
      deleteAthleteInternal(fixtures.admin, "does-not-exist"),
    ).rejects.toBeInstanceOf(AthleteNotFoundError);
  });
});

describe("assignAthletesToProgramInternal", () => {
  it("add mode is idempotent (running twice keeps one row per athlete/program)", async () => {
    const program = await createProgram();
    const athlete = await createAthleteInternal(fixtures.admin, {
      firstName: "Idem",
      lastName: `Potent-${uniqueSuffix()}`,
    });

    const first = await assignAthletesToProgramInternal(fixtures.admin, {
      athleteIds: [athlete.id],
      programId: program.id,
      mode: "add",
    });
    expect(first.added).toBe(1);

    const second = await assignAthletesToProgramInternal(fixtures.admin, {
      athleteIds: [athlete.id],
      programId: program.id,
      mode: "add",
    });
    expect(second.added).toBe(0);

    const rows = await db
      .select()
      .from(athletePrograms)
      .where(eq(athletePrograms.athleteId, athlete.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].programId).toBe(program.id);

    // One create audit row for athlete_program (idempotent second run
    // logs nothing). audit_log was truncated in beforeEach.
    const audit = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityType, "athlete_program"));
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe("create");
    expect(audit[0].entityId).toBe(`${athlete.id}:${program.id}`);

    await db
      .delete(athletePrograms)
      .where(eq(athletePrograms.athleteId, athlete.id));
    await db.delete(athletes).where(eq(athletes.id, athlete.id));
  });

  it("move mode replaces existing assignments (athlete ends in exactly the new program)", async () => {
    const programA = await createProgram();
    const programB = await createProgram();
    const athlete = await createAthleteInternal(fixtures.admin, {
      firstName: "Mover",
      lastName: `Shaker-${uniqueSuffix()}`,
    });

    // Start in program A.
    await assignAthletesToProgramInternal(fixtures.admin, {
      athleteIds: [athlete.id],
      programId: programA.id,
      mode: "add",
    });

    // Move to program B.
    const summary = await assignAthletesToProgramInternal(fixtures.admin, {
      athleteIds: [athlete.id],
      programId: programB.id,
      mode: "move",
    });
    expect(summary.removed).toBe(1);
    expect(summary.added).toBe(1);

    const rows = await db
      .select()
      .from(athletePrograms)
      .where(eq(athletePrograms.athleteId, athlete.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].programId).toBe(programB.id);

    // Audit: a delete for A and a create for B (plus the initial add's
    // create). Find the move-removal delete row.
    const deletes = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "athlete_program"),
          eq(auditLog.action, "delete"),
        ),
      );
    expect(deletes).toHaveLength(1);
    expect(deletes[0].entityId).toBe(`${athlete.id}:${programA.id}`);

    await db
      .delete(athletePrograms)
      .where(eq(athletePrograms.athleteId, athlete.id));
    await db.delete(athletes).where(eq(athletes.id, athlete.id));
  });

  it("rejects a nonexistent program (ProgramNotFoundError)", async () => {
    const athlete = await createAthleteInternal(fixtures.admin, {
      firstName: "No",
      lastName: `Program-${uniqueSuffix()}`,
    });
    await expect(
      assignAthletesToProgramInternal(fixtures.admin, {
        athleteIds: [athlete.id],
        programId: "does-not-exist",
        mode: "add",
      }),
    ).rejects.toBeInstanceOf(ProgramNotFoundError);
    await db.delete(athletes).where(eq(athletes.id, athlete.id));
  });

  it("rejects an inactive program (ProgramInactiveError)", async () => {
    const program = await createProgram(false);
    const athlete = await createAthleteInternal(fixtures.admin, {
      firstName: "Inactive",
      lastName: `Target-${uniqueSuffix()}`,
    });
    await expect(
      assignAthletesToProgramInternal(fixtures.admin, {
        athleteIds: [athlete.id],
        programId: program.id,
        mode: "add",
      }),
    ).rejects.toBeInstanceOf(ProgramInactiveError);
    await db.delete(athletes).where(eq(athletes.id, athlete.id));
  });
});
