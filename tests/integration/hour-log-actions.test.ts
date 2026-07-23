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

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  auditLog,
  hourLogs,
  programScheduleBlockCoaches,
  programScheduleBlocks,
  programs,
} from "@/db/schema";
import { ZodError } from "zod";
import { logHourInternal } from "@/lib/server/hour-log-actions";
import { upsertProgramRateOverrideInternal } from "@/lib/server/program-rate-override-actions";
import { workPayForLog } from "@/lib/billing";
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

// Track scheduled blocks we create so we can clean them up. programs and
// program_schedule_blocks are NOT truncated by truncateMutables().
const createdBlockIds: string[] = [];

beforeAll(async () => {
  fixtures = await ensureFixtureUsers();
});

beforeEach(async () => {
  await truncateMutables();
});

afterEach(async () => {
  if (createdBlockIds.length > 0) {
    // CASCADE removes the program_schedule_block_coaches join rows.
    await db
      .delete(programScheduleBlocks)
      .where(inArray(programScheduleBlocks.id, createdBlockIds));
    createdBlockIds.length = 0;
  }
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

// Like createProgram but stamps a program-level default per-30-min pay
// rate. DESIGN-1: this default is what resolveRateCentsForProgram falls
// back to when a (coach, program) override is absent or on per_session.
async function createProgramWithDefaultRate(
  defaultRatePer30MinCents: number,
): Promise<{ id: string; name: string }> {
  const name = `HourLog Test Program ${uniqueSuffix()}`;
  const [row] = await db
    .insert(programs)
    .values({ name, active: true, defaultRatePer30MinCents })
    .returning({ id: programs.id, name: programs.name });
  return row;
}

// Inserts a scheduled program block with the given coach as a member
// (both the primary scheduledCoachId and a join row). The 1b held-then-
// approve gate (logHourInternal) only posts a log as "posted" when it
// CLEANLY matches such a block within ±15min on both ends, same program;
// otherwise it holds/throws. So any test that expects a log to POST must
// first create the matching block here. Returns the block id.
async function createScheduledBlock(args: {
  programId: string;
  coachId: string;
  startAt: Date;
  endAt: Date;
}): Promise<string> {
  const [block] = await db
    .insert(programScheduleBlocks)
    .values({
      programId: args.programId,
      scheduledCoachId: args.coachId,
      startAt: args.startAt,
      endAt: args.endAt,
      createdBy: fixtures.admin.id,
    })
    .returning({ id: programScheduleBlocks.id });
  createdBlockIds.push(block.id);
  await db
    .insert(programScheduleBlockCoaches)
    .values({ blockId: block.id, coachId: args.coachId });
  return block.id;
}

describe("logHourInternal", () => {
  it("admin logs an hour against an active program → row + audit row exist", async () => {
    const program = await createProgram(true);
    const startAt = tomorrowAt(10);
    const endAt = tomorrowAt(11);

    // 1b held-then-approve gate: a schedule-confirm log only posts when it
    // cleanly matches a scheduled block the coach is a member of. Create
    // the matching block (admin is the actor here, so admin is the member).
    await createScheduledBlock({
      programId: program.id,
      coachId: fixtures.admin.id,
      startAt,
      endAt,
    });

    const created = await logHourInternal(fixtures.admin, {
      programId: program.id,
      startAt,
      endAt,
      note: "happy path",
      source: "schedule-confirm",
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
    // program, so this writes a row + audit. The 1b held-then-approve gate
    // additionally requires a matching scheduled block for the log to POST
    // (vs. be held) — that's orthogonal to DEC-29's "no per-program
    // assignment needed" point, so we create one for this program/coach.
    const program = await createProgram(true);
    const startAt = tomorrowAt(13);
    const endAt = tomorrowAt(14);
    await createScheduledBlock({
      programId: program.id,
      coachId: fixtures.coach.id,
      startAt,
      endAt,
    });

    const created = await logHourInternal(fixtures.coach, {
      programId: program.id,
      startAt,
      endAt,
      note: "any-program",
      source: "schedule-confirm",
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

// End-to-end coverage of the DESIGN-1 per-(coach, program) pay mode
// through the REAL write path (logHourInternal). The key invariants:
//   - the pay mode + rates are stamped PER (coach, program), so two
//     programs the SAME coach logs against can carry totally different
//     snapshots in the same run;
//   - a per_session override stamps a flat perSessionRateCents (and the
//     hourly rate falls through to the program default per the resolver);
//   - hour_logs is an IMMUTABLE snapshot: changing the override later
//     never re-rates an already-logged row.
//
// hour_logs is NOT truncated by truncateMutables(), so every assertion is
// scoped to the freshly-created log row's id. program_rate_overrides is
// keyed (coachId, programId); each test creates a unique program, so the
// PK never collides across tests or reruns.
describe("DESIGN-1 per-program pay mode", () => {
  // Helper: log an hour (10:00–11:00 tomorrow) against `programId` for the
  // given coach, creating the matching scheduled block first so the log
  // POSTs clean (the snapshot stamp is the same whether posted or held,
  // but posting keeps the test close to real coach usage).
  async function logCleanHour(args: {
    programId: string;
    coachId: string;
    coach: FixtureUsers["admin"];
    startHour?: number;
    endHour?: number;
  }) {
    const startAt = tomorrowAt(args.startHour ?? 10);
    const endAt = tomorrowAt(args.endHour ?? 11);
    await createScheduledBlock({
      programId: args.programId,
      coachId: args.coachId,
      startAt,
      endAt,
    });
    return logHourInternal(args.coach, {
      programId: args.programId,
      startAt,
      endAt,
      note: null,
      source: "schedule-confirm",
    });
  }

  async function readLog(id: string) {
    const [row] = await db.select().from(hourLogs).where(eq(hourLogs.id, id));
    return row;
  }

  // Migration 0052 — PROGRAM-level per-session pay, with NO coach override
  // involved. This is the path that fixes "HS Summer Travel - Game": a flat
  // fee per game logged. Before 0052 the only per-session setting lived on
  // the (coach, program) override, so a per-game fee had to be faked with an
  // hourly rate and was then paid by game LENGTH — a 3.5h game billed 3.5x.
  async function createPerSessionProgram(
    defaultPerSessionRateCents: number,
    defaultRatePer30MinCents: number | null = null,
  ): Promise<{ id: string; name: string }> {
    const name = `HourLog PerSession Program ${uniqueSuffix()}`;
    const [row] = await db
      .insert(programs)
      .values({
        name,
        active: true,
        payMode: "per_session",
        defaultPerSessionRateCents,
        defaultRatePer30MinCents,
      })
      .returning({ id: programs.id, name: programs.name });
    return row;
  }

  it("pays a program-level per-session rate as a FLAT fee, whatever the duration", async () => {
    const coach = fixtures.coach;
    // $100 a game. The stale hourly default must NOT leak onto the row.
    const program = await createPerSessionProgram(10_000, 2500);

    const short = await logCleanHour({
      programId: program.id,
      coachId: coach.id,
      coach,
      startHour: 9,
      endHour: 11, // 2 hours
    });
    const long = await logCleanHour({
      programId: program.id,
      coachId: coach.id,
      coach,
      startHour: 13,
      endHour: 17, // 4 hours — twice as long
    });

    const shortRow = await readLog(short.id);
    const longRow = await readLog(long.id);

    // The flat amount is snapshotted; no hourly basis is stamped.
    expect(shortRow.perSessionRateCents).toBe(10_000);
    expect(shortRow.ratePer30MinCents).toBeNull();
    expect(longRow.perSessionRateCents).toBe(10_000);
    expect(longRow.ratePer30MinCents).toBeNull();

    // The whole point: a 2-hour game and a 4-hour game pay exactly the same.
    expect(workPayForLog(shortRow)).toBe(10_000);
    expect(workPayForLog(longRow)).toBe(10_000);
  });

  it("a coach's hourly override still beats a per-session program", async () => {
    // The operational trap: flipping a program to per-session does NOT reach
    // coaches who hold an hourly override on it.
    const coach = fixtures.coach;
    const program = await createPerSessionProgram(10_000);
    await upsertProgramRateOverrideInternal(fixtures.admin, {
      coachId: coach.id,
      programId: program.id,
      // $30/hr — deliberately chosen so 2 hours ($60) can't be confused with
      // the program's $100 flat fee.
      payMode: "hourly",
      ratePer30MinCents: 1500,
    });

    const log = await logCleanHour({
      programId: program.id,
      coachId: coach.id,
      coach,
      startHour: 9,
      endHour: 11, // 2 hours
    });
    const row = await readLog(log.id);

    expect(row.perSessionRateCents).toBeNull();
    expect(row.ratePer30MinCents).toBe(1500);
    expect(workPayForLog(row)).toBe(6000); // 2h x $30 — not the $100 flat fee
  });

  it("stamps independent snapshots when the same coach logs against an hourly program and a per_session program", async () => {
    const coach = fixtures.coach;
    // Both programs carry the same default rate so we can prove the
    // per-program override (not the default) drives program A's snapshot.
    const programA = await createProgramWithDefaultRate(1800);
    const programB = await createProgramWithDefaultRate(1800);

    // A = hourly $50/hr → 2500 cents per 30 min.
    await upsertProgramRateOverrideInternal(fixtures.admin, {
      coachId: coach.id,
      programId: programA.id,
      payMode: "hourly",
      ratePer30MinCents: 2500,
    });
    // B = per_session $75 flat → 7500 cents.
    await upsertProgramRateOverrideInternal(fixtures.admin, {
      coachId: coach.id,
      programId: programB.id,
      payMode: "per_session",
      perSessionRateCents: 7500,
    });

    // Log a 1-hour block against each program.
    const logA = await logCleanHour({
      programId: programA.id,
      coachId: coach.id,
      coach,
      startHour: 10,
      endHour: 11,
    });
    // Different window for B so the two scheduled blocks don't overlap.
    const logB = await logCleanHour({
      programId: programB.id,
      coachId: coach.id,
      coach,
      startHour: 13,
      endHour: 14,
    });

    const rowA = await readLog(logA.id);
    const rowB = await readLog(logB.id);

    // A: hourly snapshot stamped from the override, no per-session amount.
    expect(rowA.ratePer30MinCents).toBe(2500);
    expect(rowA.perSessionRateCents).toBeNull();
    // B: per-session flat amount stamped; the hourly rate falls through to
    // the program default (resolveRateCentsForProgram ignores per_session).
    expect(rowB.perSessionRateCents).toBe(7500);
    expect(rowB.ratePer30MinCents).toBe(1800);

    // Pay: A = $50/hr × 1hr = $50 = 5000 cents.
    expect(workPayForLog(rowA)).toBe(5000);
    // B = flat $75 = 7500 cents, regardless of the 1-hour duration.
    expect(workPayForLog(rowB)).toBe(7500);
  });

  it("per_session pay is independent of the logged duration", async () => {
    const coach = fixtures.coach;
    const program = await createProgramWithDefaultRate(1800);
    await upsertProgramRateOverrideInternal(fixtures.admin, {
      coachId: coach.id,
      programId: program.id,
      payMode: "per_session",
      perSessionRateCents: 7500,
    });

    // A 3-hour block (15:00–18:00) on the same per_session override.
    const log = await logCleanHour({
      programId: program.id,
      coachId: coach.id,
      coach,
      startHour: 15,
      endHour: 18,
    });
    const row = await readLog(log.id);
    expect(row.perSessionRateCents).toBe(7500);
    // Flat $75 even though the block is 3 hours long.
    expect(workPayForLog(row)).toBe(7500);
  });

  it("no override → stamps the program default hourly rate, no per-session", async () => {
    const coach = fixtures.coach;
    const program = await createProgramWithDefaultRate(1800);
    // No upsertProgramRateOverrideInternal call: this (coach, program)
    // pair has no override row.

    const log = await logCleanHour({
      programId: program.id,
      coachId: coach.id,
      coach,
      startHour: 10,
      endHour: 11,
    });
    const row = await readLog(log.id);
    expect(row.ratePer30MinCents).toBe(1800);
    expect(row.perSessionRateCents).toBeNull();
    // $18/30min × 2 slots (1hr) = $36 = 3600 cents.
    expect(workPayForLog(row)).toBe(3600);
  });

  it("changing the override after logging never re-rates an existing log (immutable snapshot)", async () => {
    const coach = fixtures.coach;
    const program = await createProgramWithDefaultRate(1800);

    // Start on per_session $75.
    await upsertProgramRateOverrideInternal(fixtures.admin, {
      coachId: coach.id,
      programId: program.id,
      payMode: "per_session",
      perSessionRateCents: 7500,
    });

    const log = await logCleanHour({
      programId: program.id,
      coachId: coach.id,
      coach,
      startHour: 10,
      endHour: 11,
    });
    const before = await readLog(log.id);
    expect(before.perSessionRateCents).toBe(7500);
    expect(before.ratePer30MinCents).toBe(1800);
    const payBefore = workPayForLog(before);
    expect(payBefore).toBe(7500);

    // Renegotiate: flip the SAME (coach, program) override to hourly at a
    // different rate. This must NOT touch the already-logged row.
    await upsertProgramRateOverrideInternal(fixtures.admin, {
      coachId: coach.id,
      programId: program.id,
      payMode: "hourly",
      ratePer30MinCents: 9999,
    });

    const after = await readLog(log.id);
    expect(after.perSessionRateCents).toBe(7500);
    expect(after.ratePer30MinCents).toBe(1800);
    expect(workPayForLog(after)).toBe(payBefore);
  });
});
