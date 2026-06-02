// Integration tests for the internal hour-log mutation logic. These
// hit a real Neon dev branch — see vitest.integration.config.ts and
// tests/integration/setup.ts for env wiring.
//
// We call the INTERNAL function (src/lib/server/hour-log-actions.ts)
// directly with a synthetic actor instead of going through the public
// "use server" wrapper in src/app/coach/hour-log/actions.ts. The
// wrapper adds requireSession() (covered separately via mocked auth);
// calling the internal here lets the test run without mocking
// framework internals.
//
// truncateMutables() does NOT touch `programs`, so every test creates
// its own program(s) with a unique name suffix and scopes assertions to
// the created program/coach ids. audit_log IS truncated between tests.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, hourLogs, programs } from "@/db/schema";
import { ZodError } from "zod";
import { logHourInternal } from "@/lib/server/hour-log-actions";
import { ProgramInactiveError } from "@/lib/errors";
import {
  ensureFixtureUsers,
  truncateMutables,
  type FixtureUsers,
} from "./fixtures";

// logHourInternal → @/lib/authz → @/auth → next-auth, which fails to
// resolve in the vitest node environment. We never exercise the real
// auth() here (we call the internal fn with a synthetic actor), so
// stubbing @/auth is purely to break that import chain.
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

// Tomorrow at the given UTC hour. Far enough out that overlapping with
// any real fixture is impossible; hour_logs has no overlap constraint
// anyway, but keeps times sane.
function tomorrowAt(hour: number, minute = 0): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(hour, minute, 0, 0);
  return d;
}

// Unique suffix so concurrent / repeated runs never collide on the
// unique program name.
function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createProgram(active: boolean): Promise<{
  id: string;
  name: string;
}> {
  const name = `HourLog Test Program ${uniqueSuffix()}`;
  const [row] = await db
    .insert(programs)
    .values({ name, active })
    .returning({ id: programs.id, name: programs.name });
  return row;
}

describe("logHourInternal", () => {
  it("admin logs an hour against an active program → row + audit row exist", async () => {
    const program = await createProgram(true);
    const startAt = tomorrowAt(10);
    const endAt = tomorrowAt(11);

    const created = await logHourInternal(fixtures.admin, {
      programId: program.id,
      startAt,
      endAt,
      note: "happy path",
    });

    expect(created.id).toBeTruthy();
    expect(created.programId).toBe(program.id);
    expect(created.coachId).toBe(fixtures.admin.id);
    expect(created.createdBy).toBe(fixtures.admin.id);
    expect(created.note).toBe("happy path");

    const rows = await db
      .select()
      .from(hourLogs)
      .where(eq(hourLogs.id, created.id));
    expect(rows).toHaveLength(1);

    const audit = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.entityId, created.id), eq(auditLog.action, "create")),
      );
    expect(audit).toHaveLength(1);
    expect(audit[0].actorUserId).toBe(fixtures.admin.id);
    expect(audit[0].entityType).toBe("hour_log");
  });

  it("rejects end <= start (ZodError) and writes nothing", async () => {
    const program = await createProgram(true);

    await expect(
      logHourInternal(fixtures.admin, {
        programId: program.id,
        startAt: tomorrowAt(11),
        endAt: tomorrowAt(11),
        note: null,
      }),
    ).rejects.toBeInstanceOf(ZodError);

    const rows = await db
      .select()
      .from(hourLogs)
      .where(eq(hourLogs.programId, program.id));
    expect(rows).toHaveLength(0);
    const audits = await db.select().from(auditLog);
    expect(audits).toHaveLength(0);
  });

  it("rejects an inactive program with ProgramInactiveError and writes nothing", async () => {
    const program = await createProgram(false);

    const promise = logHourInternal(fixtures.admin, {
      programId: program.id,
      startAt: tomorrowAt(10),
      endAt: tomorrowAt(11),
      note: null,
    });

    await expect(promise).rejects.toBeInstanceOf(ProgramInactiveError);
    try {
      await promise;
    } catch (err) {
      const e = err as ProgramInactiveError;
      expect(e.programId).toBe(program.id);
      expect(e.programName).toBe(program.name);
    }

    const rows = await db
      .select()
      .from(hourLogs)
      .where(eq(hourLogs.programId, program.id));
    expect(rows).toHaveLength(0);
  });

  it("allows a coach to log against any active program — no assignment needed (DEC-29)", async () => {
    // Active program; the coach has NO coach_programs assignment (the
    // feature was removed). DEC-29: any coach may log against any active
    // program, so this writes a row + audit.
    const program = await createProgram(true);

    const created = await logHourInternal(fixtures.coach, {
      programId: program.id,
      startAt: tomorrowAt(13),
      endAt: tomorrowAt(14),
      note: "any-program",
    });

    expect(created.coachId).toBe(fixtures.coach.id);
    expect(created.createdBy).toBe(fixtures.coach.id);
    expect(created.programId).toBe(program.id);

    const rows = await db
      .select()
      .from(hourLogs)
      .where(eq(hourLogs.programId, program.id));
    expect(rows).toHaveLength(1);

    const audit = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.entityId, created.id), eq(auditLog.action, "create")),
      );
    expect(audit).toHaveLength(1);
    expect(audit[0].actorUserId).toBe(fixtures.coach.id);
    expect(audit[0].entityType).toBe("hour_log");
  });
});
