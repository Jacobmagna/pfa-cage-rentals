// Integration tests for the stipend EARNING TRIGGER and the Sept-1 backfill
// (stipend SPEC §4.3 / §15.1, Phase B4). Real Neon dev branch.
//
// 🔴 WHAT THIS FILE EXISTS TO LOCK DOWN — in order of what it costs when it
// breaks:
//
//   1. THE DOUBLE-PAY LANDMINE (T10). A covered log on a program that HAS a
//      non-zero default rate must stamp NO rate. Every fixture here therefore
//      carries a non-zero program default — that rate is the fall-through's
//      ammunition, and a fixture without one proves nothing. Each covered
//      assertion is paired with an UNCOVERED CONTROL on the same call: a test
//      asserting "this pays $0" passes trivially against a fixture that pays
//      $0 for the wrong reason.
//
//   2. ALL THREE POSTED MOMENTS EARN. Missing one means a coach silently is
//      not paid. Two live in `logHourInternal` (the insert, and the held →
//      posted auto-upgrade buried in the duplicate-conflict branch) and one in
//      `approveHeldHourLogInternal`.
//
//   3. R4 — ONE STIPEND PER PERIOD (T6). One logged hour and forty earn the
//      same single stipend, enforced by UNIQUE (coach_id, period_key).
//
//   4. Q3 — THE EARNING STANDS. Deleting the hour log that earned a stipend
//      must NOT delete the earning. The FK is ON DELETE SET NULL, and this is
//      the test that proves the clause rather than trusting the migration.
//
//   5. T12 — HOURS AND PAY DECOUPLE. A covered log's hours are untouched.
//      Mark wants to SEE all 72 hours while they charge him $0.

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
  coachStipendEarnings,
  hourLogs,
  programScheduleBlockCoaches,
  programScheduleBlocks,
  programs,
} from "@/db/schema";
import {
  approveHeldHourLogInternal,
  fetchStipendAmountCentsForPeriod,
  logHourInternal,
  updateHourInternal,
} from "@/lib/server/hour-log-actions";
import { setCoachStipendInternal } from "@/lib/server/stipend-actions";
import {
  createProgramInternal,
  updateProgramInternal,
} from "@/lib/server/program-actions";
import {
  backfillStipendEarnings,
  SANCTIONED_FLOOR,
  StipendBackfillFloorError,
} from "@/lib/stipend/backfill";
import { parsePfaInput } from "@/lib/timezone";
import { workPayForLog } from "@/lib/billing";
import {
  ensureFixtureUsers,
  truncateMutables,
  type FixtureUsers,
} from "./fixtures";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

let fixtures: FixtureUsers;
const createdBlockIds: string[] = [];
const createdProgramIds: string[] = [];

beforeAll(async () => {
  fixtures = await ensureFixtureUsers();
});

beforeEach(async () => {
  await truncateMutables();
  // 🔴 `hour_logs` is NOT in truncateMutables, and the BACKFILL scans the whole
  // table rather than one program — so a covered log left behind by an earlier
  // test in this file would be counted as a candidate here and inflate every
  // count. Nothing outside this suite ever sets `stipend_covered = true`, so
  // this delete is precise and cannot disturb another suite's fixtures.
  await db.delete(hourLogs).where(eq(hourLogs.stipendCovered, true));
});

afterEach(async () => {
  // `programs` and `program_schedule_blocks` are NOT truncated by
  // truncateMutables(), so this suite cleans up after itself.
  //
  // ⚠️ ORDER MATTERS. `hour_logs.program_id` is a plain FK with NO cascade, so
  // the logs must go BEFORE their programs or the delete errors with a 23503
  // and the whole test fails in its teardown. (An earning's FK to a deleted
  // log is SET NULL rather than CASCADE — that is the Q3 behaviour under test,
  // and earnings are cleared by truncateMutables instead.)
  if (createdProgramIds.length > 0) {
    await db
      .delete(hourLogs)
      .where(inArray(hourLogs.programId, createdProgramIds));
  }
  if (createdBlockIds.length > 0) {
    await db
      .delete(programScheduleBlocks)
      .where(inArray(programScheduleBlocks.id, createdBlockIds));
    createdBlockIds.length = 0;
  }
  if (createdProgramIds.length > 0) {
    await db.delete(programs).where(inArray(programs.id, createdProgramIds));
    createdProgramIds.length = 0;
  }
});

/* ── fixtures ─────────────────────────────────────────────────────────────── */

const STIPEND_CENTS = 250_000; // $2,500 — Nick's real manager-work number.
/** 🔴 Non-zero on purpose: the program-default fall-through's ammunition. */
const PROGRAM_DEFAULT_RATE = 3_000; // $30 per 30 min

/** Sept 2026 — after the sanctioned floor, and a future date. */
function sept(day: number, time = "10:00"): Date {
  return parsePfaInput(`2026-09-${String(day).padStart(2, "0")}`, time);
}

const NOW = parsePfaInput("2026-08-20", "11:00");

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createProgram(stipendEligible: boolean) {
  const [row] = await db
    .insert(programs)
    .values({
      name: `Stipend Test Program ${uniqueSuffix()}`,
      active: true,
      // 🔴 EVERY program here carries a real default rate. Without it, a
      // covered log would stamp null whether or not the guard exists.
      defaultRatePer30MinCents: PROGRAM_DEFAULT_RATE,
      stipendEligible,
    })
    .returning({ id: programs.id, name: programs.name });
  createdProgramIds.push(row.id);
  return row;
}

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

/** Give the coach a stipend effective Sept 1. */
async function putCoachOnStipend(coachId: string, amountCents = STIPEND_CENTS) {
  return setCoachStipendInternal(
    fixtures.admin,
    { coachId, amountCents, effectiveFrom: parsePfaInput("2026-09-01", "00:00") },
    NOW,
  );
}

/** Log a CLEAN (auto-posting) hour against a matching scheduled block. */
async function logCleanHour(args: {
  coachId: string;
  programId: string;
  startAt: Date;
  endAt: Date;
}) {
  await createScheduledBlock(args);
  const actor = { ...fixtures.coach, id: args.coachId };
  return logHourInternal(actor as typeof fixtures.coach, {
    programId: args.programId,
    startAt: args.startAt,
    endAt: args.endAt,
  });
}

async function earningAuditRows(earningId: string) {
  return db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityType, "coach_stipend_earning"),
        eq(auditLog.entityId, earningId),
      ),
    );
}

async function earningsFor(coachId: string) {
  return db
    .select()
    .from(coachStipendEarnings)
    .where(eq(coachStipendEarnings.coachId, coachId));
}

/* ── T10 / T11 / T12 — the pay decoupling, at the DB level ───────────────── */

describe("🔴 T10 — a covered log stamps NO rate, even with a program default", () => {
  it("stamps null on a covered program AND its uncovered control pays hourly", async () => {
    const { coach } = fixtures;
    await putCoachOnStipend(coach.id);

    const covered = await createProgram(true);
    const uncovered = await createProgram(false); // ← the CONTROL

    const coveredLog = await logCleanHour({
      coachId: coach.id,
      programId: covered.id,
      startAt: sept(3, "09:00"),
      endAt: sept(3, "11:00"),
    });
    const uncoveredLog = await logCleanHour({
      coachId: coach.id,
      programId: uncovered.id,
      startAt: sept(3, "19:00"),
      endAt: sept(3, "21:00"),
    });

    // The covered log: real hours, NO rate, $0 pay.
    expect(coveredLog!.stipendCovered).toBe(true);
    expect(coveredLog!.ratePer30MinCents).toBeNull();
    expect(coveredLog!.perSessionRateCents).toBeNull();
    expect(workPayForLog(coveredLog!)).toBe(0);

    // 🔴 THE CONTROL. Without this passing, the assertion above proves
    // nothing — a fixture that pays $0 for the wrong reason would look
    // identical. This is Nick's weightlifting, paid hourly ON TOP (T11).
    expect(uncoveredLog!.stipendCovered).toBe(false);
    expect(uncoveredLog!.ratePer30MinCents).toBe(PROGRAM_DEFAULT_RATE);
    expect(workPayForLog(uncoveredLog!)).toBe(PROGRAM_DEFAULT_RATE * 4);
  });

  it("🔴 T12 — the covered log's HOURS are untouched", async () => {
    const { coach } = fixtures;
    await putCoachOnStipend(coach.id);
    const covered = await createProgram(true);

    const log = await logCleanHour({
      coachId: coach.id,
      programId: covered.id,
      startAt: sept(4, "08:00"),
      endAt: sept(4, "12:00"), // four real hours
    });

    const spanMs = log!.endAt.getTime() - log!.startAt.getTime();
    expect(spanMs / (60 * 60 * 1000)).toBe(4);
    // Hours real, pay zero — Mark's requirement in one assertion.
    expect(workPayForLog(log!)).toBe(0);
  });

  it("a coach with NO stipend amount is not covered, even on an eligible program", async () => {
    const { coach } = fixtures;
    const covered = await createProgram(true); // eligible, but no amount on file

    const log = await logCleanHour({
      coachId: coach.id,
      programId: covered.id,
      startAt: sept(5, "09:00"),
      endAt: sept(5, "10:00"),
    });

    // 🔴 Coverage is program-eligible AND coach-has-an-amount. Requiring the
    // coach half is what stops a non-stipend coach who covers one shift on a
    // stipend program from working for free.
    expect(log!.stipendCovered).toBe(false);
    expect(log!.ratePer30MinCents).toBe(PROGRAM_DEFAULT_RATE);
    expect(await earningsFor(coach.id)).toHaveLength(0);
  });
});

/* ── 🔴 THE OPERATOR'S PATH ──────────────────────────────────────────────── */

/**
 * Create a program through the APP'S OWN ACTION rather than a raw INSERT.
 *
 * 🔴 This is the whole point of the block below. Every other fixture in this
 * file writes `stipend_eligible` with SQL, which is exactly why the feature
 * could pass 1,591 unit tests, 502 integration tests and eleven mutations
 * while being completely unusable: the column had three readers and no
 * writers, so nothing an admin could do in the product ever set it. A test
 * that sets it directly proves the resolver; only a test that goes through
 * `createProgramInternal` / `updateProgramInternal` proves Mark can reach it.
 */
async function createProgramViaAction(stipendEligible: boolean) {
  const row = await createProgramInternal(fixtures.admin, {
    name: `Stipend Toggle Test ${uniqueSuffix()}`,
    // 🔴 Non-zero, like every other fixture here: the program-default
    // fall-through's ammunition. Without it a covered log would stamp null
    // whether or not the switch is doing anything.
    defaultRatePer30MinCents: PROGRAM_DEFAULT_RATE,
    stipendEligible,
  });
  createdProgramIds.push(row.id);
  return row;
}

describe("🔴 the admin toggle actually reaches the money", () => {
  it("a program made eligible THROUGH THE ACTION covers a stipend coach's log", async () => {
    const { coach } = fixtures;
    await putCoachOnStipend(coach.id);

    const covered = await createProgramViaAction(true);
    const uncovered = await createProgramViaAction(false); // ← the CONTROL

    const coveredLog = await logCleanHour({
      coachId: coach.id,
      programId: covered.id,
      startAt: sept(8, "09:00"),
      endAt: sept(8, "11:00"),
    });
    const uncoveredLog = await logCleanHour({
      coachId: coach.id,
      programId: uncovered.id,
      startAt: sept(8, "19:00"),
      endAt: sept(8, "21:00"),
    });

    expect(coveredLog!.stipendCovered).toBe(true);
    expect(coveredLog!.ratePer30MinCents).toBeNull();
    expect(workPayForLog(coveredLog!)).toBe(0);

    // 🔴 THE CONTROL. Both programs were created the same way, one call apart;
    // the ONLY difference is the flag the admin set. Without this passing, the
    // $0 above could be $0 for any other reason.
    expect(uncoveredLog!.stipendCovered).toBe(false);
    expect(uncoveredLog!.ratePer30MinCents).toBe(PROGRAM_DEFAULT_RATE);
    expect(workPayForLog(uncoveredLog!)).toBe(PROGRAM_DEFAULT_RATE * 4);
  });

  it("🔴 FLIPPING the toggle is what changes the pay — before it, nothing happens", async () => {
    // This is the merge blocker, as a test. Before the toggle existed, an
    // admin could put a coach on a $2,500 stipend and watch every log keep
    // paying hourly, with no way to reach the switch that would change it.
    const { coach } = fixtures;
    await putCoachOnStipend(coach.id);

    const program = await createProgramViaAction(false);

    // BEFORE — the state the whole feature was stuck in.
    const before = await logCleanHour({
      coachId: coach.id,
      programId: program.id,
      startAt: sept(9, "09:00"),
      endAt: sept(9, "11:00"),
    });
    expect(before!.stipendCovered).toBe(false);
    expect(before!.ratePer30MinCents).toBe(PROGRAM_DEFAULT_RATE);
    expect(await earningsFor(coach.id)).toHaveLength(0);

    // THE ADMIN TICKS THE BOX.
    const updated = await updateProgramInternal(fixtures.admin, program.id, {
      stipendEligible: true,
    });
    expect(updated.stipendEligible).toBe(true);

    // AFTER — same coach, same program, same shift length.
    const after = await logCleanHour({
      coachId: coach.id,
      programId: program.id,
      startAt: sept(9, "13:00"),
      endAt: sept(9, "15:00"),
    });
    expect(after!.stipendCovered).toBe(true);
    expect(after!.ratePer30MinCents).toBeNull();
    expect(workPayForLog(after!)).toBe(0);

    // 🔴 And the money actually moved: the flip is what caused the stipend to
    // be earned at all. One earning, not two — R4 holds across the change.
    expect(await earningsFor(coach.id)).toHaveLength(1);

    // 🔴 THE IMMUTABLE SNAPSHOT (SPEC §3.3). The log written BEFORE the flip
    // keeps its hourly rate. Coverage is stamped at write time and never
    // recomputed, so ticking the box is not a retro — which is exactly what
    // the checkbox's own copy promises the admin.
    const [beforeNow] = await db
      .select()
      .from(hourLogs)
      .where(eq(hourLogs.id, before!.id))
      .limit(1);
    expect(beforeNow.stipendCovered).toBe(false);
    expect(beforeNow.ratePer30MinCents).toBe(PROGRAM_DEFAULT_RATE);
  });

  it("🔴 UN-ticking the box stops covering new logs, and does not un-zero old ones", async () => {
    const { coach } = fixtures;
    await putCoachOnStipend(coach.id);

    const program = await createProgramViaAction(true);

    const whileCovered = await logCleanHour({
      coachId: coach.id,
      programId: program.id,
      startAt: sept(10, "09:00"),
      endAt: sept(10, "11:00"),
    });
    expect(whileCovered!.stipendCovered).toBe(true);

    await updateProgramInternal(fixtures.admin, program.id, {
      stipendEligible: false,
    });

    const afterOff = await logCleanHour({
      coachId: coach.id,
      programId: program.id,
      startAt: sept(10, "13:00"),
      endAt: sept(10, "15:00"),
    });
    // New work is paid hourly again.
    expect(afterOff!.stipendCovered).toBe(false);
    expect(afterOff!.ratePer30MinCents).toBe(PROGRAM_DEFAULT_RATE);

    // 🔴 The already-covered log stays covered. If un-ticking re-priced it,
    // the coach would be paid hourly for work their stipend already paid for
    // — the double-pay landmine, reached from a checkbox.
    const [stillCovered] = await db
      .select()
      .from(hourLogs)
      .where(eq(hourLogs.id, whileCovered!.id))
      .limit(1);
    expect(stillCovered.stipendCovered).toBe(true);
    expect(stillCovered.ratePer30MinCents).toBeNull();
  });
});

/* ── the three posted moments ────────────────────────────────────────────── */

describe("🔴 the earning trigger — all three posted moments", () => {
  it("MOMENT 1 — a clean log's INSERT earns the stipend", async () => {
    const { coach } = fixtures;
    await putCoachOnStipend(coach.id);
    const program = await createProgram(true);

    const log = await logCleanHour({
      coachId: coach.id,
      programId: program.id,
      startAt: sept(2, "09:00"),
      endAt: sept(2, "11:00"),
    });

    const earnings = await earningsFor(coach.id);
    expect(earnings).toHaveLength(1);
    expect(earnings[0].periodKey).toBe("2026-09-P1");
    expect(earnings[0].amountCents).toBe(STIPEND_CENTS);
    expect(earnings[0].earnedByHourLogId).toBe(log!.id);
    expect(earnings[0].voidedAt).toBeNull();
  });

  it("🔴 a coach ON a stipend earns NOTHING from an UNCOVERED program", async () => {
    // 🔴 THIS TEST EXISTS BECAUSE A MUTATION SURVIVED WITHOUT IT. Deleting the
    // `if (!stipendCovered) return not_applicable` guard from
    // `recordStipendEarning` broke NO test: the only uncovered fixture at the
    // time was a coach with no stipend AMOUNT, so the amount==null check
    // caught it and the coverage guard went unverified. Two independent
    // reasons produced the right answer, and neither was under test.
    //
    // The real case is Nick: on a $2,500 stipend, but in this period he only
    // ever logged WEIGHTLIFTING, which his stipend does not cover. He is paid
    // hourly for it and earns no stipend — being on a stipend is not itself
    // the trigger. (SPEC §2.12 / D14.)
    const { coach } = fixtures;
    await putCoachOnStipend(coach.id);
    const uncovered = await createProgram(false);

    const log = await logCleanHour({
      coachId: coach.id,
      programId: uncovered.id,
      startAt: sept(8, "19:00"),
      endAt: sept(8, "21:00"),
    });

    expect(log!.stipendCovered).toBe(false);
    // The POSITIVE CONTROL on the same call: the hours really were paid, so
    // "no earning" cannot be passing because nothing happened at all.
    expect(log!.ratePer30MinCents).toBe(PROGRAM_DEFAULT_RATE);
    expect(workPayForLog(log!)).toBe(PROGRAM_DEFAULT_RATE * 4);
    expect(await earningsFor(coach.id)).toHaveLength(0);
  });

  it("🔴 an earned stipend is AUDITED — and the actor must be a REAL user", async () => {
    // 🔴 REGRESSION TEST FOR A DEFECT THE ADVERSARIAL PASS FOUND, and one this
    // suite could not previously have caught: `audit_log.actor_user_id` is NOT
    // NULL with an FK to `users.id`, and `safeLogAudit` SWALLOWS its failures
    // by design. The backfill CLI passed the literal string
    // "system:stipend-backfill", which violates that FK with a 23503 — so the
    // one-time run that creates real back-pay would have written EVERY earning
    // with NO AUDIT TRAIL, silently.
    //
    // The tests passed because they use a real admin id. This one now asserts
    // the audit row EXISTS rather than assuming the write succeeded.
    const { coach } = fixtures;
    await putCoachOnStipend(coach.id);
    const program = await createProgram(true);
    await logCleanHour({
      coachId: coach.id,
      programId: program.id,
      startAt: sept(2, "09:00"),
      endAt: sept(2, "11:00"),
    });

    const [earning] = await earningsFor(coach.id);
    expect(earning).toBeDefined();
    const audits = await earningAuditRows(earning.id);
    expect(audits, "an earned stipend with no audit row").toHaveLength(1);
    expect(audits[0].action).toBe("create");
    // The actor is a real users row — that is the FK the fake string broke.
    expect(audits[0].actorUserId).toBe(coach.id);
    const diff = audits[0].diff as { after?: Record<string, unknown> };
    expect(diff.after?.amountCents).toBe(STIPEND_CENTS);
    expect(diff.after?.periodKey).toBe("2026-09-P1");
  });

  it("MOMENT 3 — approving a HELD log earns it; the held log alone does not", async () => {
    const { admin, coach } = fixtures;
    await putCoachOnStipend(coach.id);
    const program = await createProgram(true);

    // No scheduled block → the log is anomalous, and posts HELD only with the
    // coach's explicit acknowledgement.
    const held = await logHourInternal(coach, {
      programId: program.id,
      startAt: sept(6, "09:00"),
      endAt: sept(6, "11:00"),
      acknowledgeHold: true,
    });
    expect(held!.status).toBe("held");
    // 🔴 A HELD log earns NOTHING. Mark's own answer: posted only.
    expect(await earningsFor(coach.id)).toHaveLength(0);

    await approveHeldHourLogInternal(admin, held!.id);

    const earnings = await earningsFor(coach.id);
    expect(earnings).toHaveLength(1);
    expect(earnings[0].periodKey).toBe("2026-09-P1");
  });

  it("MOMENT 2 — the HELD → POSTED auto-upgrade earns it", async () => {
    const { coach } = fixtures;
    await putCoachOnStipend(coach.id);
    const program = await createProgram(true);

    const startAt = sept(7, "09:00");
    const endAt = sept(7, "11:00");

    // First: no block yet → held.
    const held = await logHourInternal(coach, {
      programId: program.id,
      startAt,
      endAt,
      acknowledgeHold: true,
    });
    expect(held!.status).toBe("held");
    expect(await earningsFor(coach.id)).toHaveLength(0);

    // Now the block exists and the identical window is re-confirmed cleanly.
    // That hits the duplicate-conflict branch and upgrades held → posted.
    await createScheduledBlock({
      programId: program.id,
      coachId: coach.id,
      startAt,
      endAt,
    });
    const upgraded = await logHourInternal(coach, {
      programId: program.id,
      startAt,
      endAt,
    });
    expect(upgraded!.status).toBe("posted");

    // 🔴 The moment a reader misses. If this is 0, a coach who re-confirmed a
    // held shift is silently unpaid for the half-month.
    expect(await earningsFor(coach.id)).toHaveLength(1);
  });

  it("🔴 approving a SEPTEMBER log in a later month earns a SEPTEMBER stipend", async () => {
    const { admin, coach } = fixtures;
    await putCoachOnStipend(coach.id);
    const program = await createProgram(true);

    const held = await logHourInternal(coach, {
      programId: program.id,
      startAt: sept(20, "09:00"), // 2026-09-P2
      endAt: sept(20, "11:00"),
      acknowledgeHold: true,
    });
    await approveHeldHourLogInternal(admin, held!.id);

    const earnings = await earningsFor(coach.id);
    expect(earnings).toHaveLength(1);
    // Bucketed by the LOG's own startAt. The approval date never buckets.
    expect(earnings[0].periodKey).toBe("2026-09-P2");
  });
});

/* ── TIME EDITS THAT MOVE A LOG BETWEEN PAY PERIODS ─────────────────────── */

describe("🔴 an admin EDIT that moves a covered log into another pay period", () => {
  it("earns the NEW period, and the old earning still stands", async () => {
    // 🔴 REGRESSION TEST FOR A GAP THE ADVERSARIAL PASS FOUND. The trigger
    // fires when a log becomes POSTED — but `updateHourInternal` can change a
    // POSTED log's start/end times, and an edit is not a post. So an admin
    // correcting a date from Sep 3 to Sep 20 moved real covered work into
    // 2026-09-P2 while NOTHING ever earned that period's stipend. The coach is
    // silently short a half-month's pay, and the only evidence is an absence.
    //
    // Both halves are asserted together because they are the whole rule:
    //   · the NEW period earns (the gap being closed), and
    //   · the OLD earning STANDS (Mark's Q3 — nothing automatic un-earns).
    const { admin, coach } = fixtures;
    await putCoachOnStipend(coach.id);
    const program = await createProgram(true);

    const log = await logCleanHour({
      coachId: coach.id,
      programId: program.id,
      startAt: sept(3, "09:00"),
      endAt: sept(3, "11:00"),
    });
    expect((await earningsFor(coach.id)).map((e) => e.periodKey)).toEqual([
      "2026-09-P1",
    ]);

    await updateHourInternal(admin, log!.id, {
      programId: program.id,
      startAt: sept(20, "09:00"),
      endAt: sept(20, "11:00"),
    });

    const keys = (await earningsFor(coach.id)).map((e) => e.periodKey).sort();
    expect(keys).toEqual(["2026-09-P1", "2026-09-P2"]);
  });

  it("an edit WITHIN the same period earns nothing new (R4 still holds)", async () => {
    // The positive control. Without it, "the edit earns a period" could be
    // passing because every edit earns something, which would double-pay any
    // coach whose times get corrected.
    const { admin, coach } = fixtures;
    await putCoachOnStipend(coach.id);
    const program = await createProgram(true);

    const log = await logCleanHour({
      coachId: coach.id,
      programId: program.id,
      startAt: sept(3, "09:00"),
      endAt: sept(3, "11:00"),
    });
    await updateHourInternal(admin, log!.id, {
      programId: program.id,
      startAt: sept(5, "09:00"),
      endAt: sept(5, "11:00"),
    });

    expect(await earningsFor(coach.id)).toHaveLength(1);
  });

  it("an edit on an UNCOVERED log earns nothing at all", async () => {
    // The second control: the coverage guard still governs on this path.
    const { admin, coach } = fixtures;
    await putCoachOnStipend(coach.id);
    const uncovered = await createProgram(false);

    const log = await logCleanHour({
      coachId: coach.id,
      programId: uncovered.id,
      startAt: sept(3, "19:00"),
      endAt: sept(3, "21:00"),
    });
    await updateHourInternal(admin, log!.id, {
      programId: uncovered.id,
      startAt: sept(20, "19:00"),
      endAt: sept(20, "21:00"),
    });

    expect(await earningsFor(coach.id)).toHaveLength(0);
  });
});

/* ── R4 / T6 — one stipend per period ────────────────────────────────────── */

describe("🔴 R4 — one logged hour and many earn the SAME single stipend", () => {
  it("T6 — six logs in one period yield exactly one earning", async () => {
    const { coach } = fixtures;
    await putCoachOnStipend(coach.id);
    const program = await createProgram(true);

    for (const day of [2, 3, 4, 8, 9, 10]) {
      await logCleanHour({
        coachId: coach.id,
        programId: program.id,
        startAt: sept(day, "09:00"),
        endAt: sept(day, "11:00"),
      });
    }

    const earnings = await earningsFor(coach.id);
    expect(earnings).toHaveLength(1);
    expect(earnings[0].amountCents).toBe(STIPEND_CENTS);
  });

  it("logs in BOTH halves of the month earn two — one per period", async () => {
    const { coach } = fixtures;
    await putCoachOnStipend(coach.id);
    const program = await createProgram(true);

    await logCleanHour({
      coachId: coach.id,
      programId: program.id,
      startAt: sept(10, "09:00"),
      endAt: sept(10, "11:00"),
    });
    await logCleanHour({
      coachId: coach.id,
      programId: program.id,
      startAt: sept(22, "09:00"),
      endAt: sept(22, "11:00"),
    });

    const earnings = await earningsFor(coach.id);
    expect(earnings.map((e) => e.periodKey).sort()).toEqual([
      "2026-09-P1",
      "2026-09-P2",
    ]);
  });

  it("🔴 the 15th and the 16th are DIFFERENT periods", async () => {
    const { coach } = fixtures;
    await putCoachOnStipend(coach.id);
    const program = await createProgram(true);

    await logCleanHour({
      coachId: coach.id,
      programId: program.id,
      startAt: sept(15, "20:00"), // late on the 15th PFA — still P1
      endAt: sept(15, "22:00"),
    });
    await logCleanHour({
      coachId: coach.id,
      programId: program.id,
      startAt: sept(16, "06:00"),
      endAt: sept(16, "08:00"),
    });

    const earnings = await earningsFor(coach.id);
    expect(earnings.map((e) => e.periodKey).sort()).toEqual([
      "2026-09-P1",
      "2026-09-P2",
    ]);
  });
});

/* ── Q3 — the earning STANDS ─────────────────────────────────────────────── */

describe("🔴 Q3 — deleting the hour log does NOT un-earn the stipend", () => {
  it("keeps the earning and nulls the link (ON DELETE SET NULL, not CASCADE)", async () => {
    const { coach } = fixtures;
    await putCoachOnStipend(coach.id);
    const program = await createProgram(true);

    const log = await logCleanHour({
      coachId: coach.id,
      programId: program.id,
      startAt: sept(2, "09:00"),
      endAt: sept(2, "11:00"),
    });
    expect(await earningsFor(coach.id)).toHaveLength(1);

    await db.delete(hourLogs).where(eq(hourLogs.id, log!.id));

    const after = await earningsFor(coach.id);
    // 🔴 A CASCADE here would return 0 — a coach un-paid for a half-month
    // they worked, by an action that has nothing to do with stipends.
    expect(after).toHaveLength(1);
    expect(after[0].amountCents).toBe(STIPEND_CENTS);
    expect(after[0].earnedByHourLogId).toBeNull();
  });
});

/* ── §15.1 — the Sept-1 backfill ─────────────────────────────────────────── */

describe("§15.1 — the idempotent Sept-1 backfill", () => {
  /** Insert a posted, covered log directly, bypassing the live trigger. */
  async function seedUntriggeredLog(args: {
    coachId: string;
    programId: string;
    startAt: Date;
    endAt: Date;
  }) {
    const [row] = await db
      .insert(hourLogs)
      .values({
        coachId: args.coachId,
        programId: args.programId,
        startAt: args.startAt,
        endAt: args.endAt,
        status: "posted",
        stipendCovered: true,
        ratePer30MinCents: null,
        createdBy: args.coachId,
      })
      .returning();
    return row;
  }

  it("a DRY RUN finds the pairs and writes nothing", async () => {
    const { admin, coach } = fixtures;
    await putCoachOnStipend(coach.id);
    const program = await createProgram(true);
    await seedUntriggeredLog({
      coachId: coach.id,
      programId: program.id,
      startAt: sept(3, "09:00"),
      endAt: sept(3, "11:00"),
    });

    const report = await backfillStipendEarnings({
      actorUserId: admin.id,
      resolveAmountCents: fetchStipendAmountCentsForPeriod,
    });

    expect(report.applied).toBe(false);
    expect(report.counts.candidatePairs).toBe(1);
    expect(report.candidates[0].period.key).toBe("2026-09-P1");
    // 🔴 Nothing written. A dry run that writes is not a dry run.
    expect(await earningsFor(coach.id)).toHaveLength(0);
  });

  it("collapses many logs in one period to ONE candidate, then earns once", async () => {
    const { admin, coach } = fixtures;
    await putCoachOnStipend(coach.id);
    const program = await createProgram(true);
    for (const day of [3, 4, 5]) {
      await seedUntriggeredLog({
        coachId: coach.id,
        programId: program.id,
        startAt: sept(day, "09:00"),
        endAt: sept(day, "11:00"),
      });
    }

    const dry = await backfillStipendEarnings({
      actorUserId: admin.id,
      resolveAmountCents: fetchStipendAmountCentsForPeriod,
    });
    expect(dry.counts.coveredLogsScanned).toBe(3);
    expect(dry.counts.candidatePairs).toBe(1);
    expect(dry.candidates[0].logCount).toBe(3);

    const applied = await backfillStipendEarnings({
      actorUserId: admin.id,
      resolveAmountCents: fetchStipendAmountCentsForPeriod,
      apply: true,
    });
    expect(applied.counts.earned).toBe(1);
    expect(applied.counts.failed).toBe(0);
    expect(await earningsFor(coach.id)).toHaveLength(1);
  });

  it("🔴 is IDEMPOTENT — a second apply creates nothing", async () => {
    const { admin, coach } = fixtures;
    await putCoachOnStipend(coach.id);
    const program = await createProgram(true);
    await seedUntriggeredLog({
      coachId: coach.id,
      programId: program.id,
      startAt: sept(3, "09:00"),
      endAt: sept(3, "11:00"),
    });

    const first = await backfillStipendEarnings({
      actorUserId: admin.id,
      resolveAmountCents: fetchStipendAmountCentsForPeriod,
      apply: true,
    });
    const second = await backfillStipendEarnings({
      actorUserId: admin.id,
      resolveAmountCents: fetchStipendAmountCentsForPeriod,
      apply: true,
    });

    expect(first.counts.earned).toBe(1);
    expect(second.counts.earned).toBe(0);
    expect(second.counts.alreadyEarned).toBe(1);
    expect(await earningsFor(coach.id)).toHaveLength(1);
  });

  it("does not double-earn a period the LIVE trigger already earned", async () => {
    const { admin, coach } = fixtures;
    await putCoachOnStipend(coach.id);
    const program = await createProgram(true);

    // Earned live.
    await logCleanHour({
      coachId: coach.id,
      programId: program.id,
      startAt: sept(3, "09:00"),
      endAt: sept(3, "11:00"),
    });
    expect(await earningsFor(coach.id)).toHaveLength(1);

    const report = await backfillStipendEarnings({
      actorUserId: admin.id,
      resolveAmountCents: fetchStipendAmountCentsForPeriod,
      apply: true,
    });
    expect(report.counts.earned).toBe(0);
    expect(report.counts.alreadyEarned).toBe(1);
    expect(await earningsFor(coach.id)).toHaveLength(1);
  });

  it("🔴 REFUSES a fromDate before the sanctioned floor", async () => {
    await expect(
      backfillStipendEarnings({
        actorUserId: fixtures.admin.id,
        resolveAmountCents: fetchStipendAmountCentsForPeriod,
        fromDate: parsePfaInput("2026-08-01", "00:00"),
      }),
    ).rejects.toBeInstanceOf(StipendBackfillFloorError);
  });

  it("refuses a fromDate that is not a period start", async () => {
    await expect(
      backfillStipendEarnings({
        actorUserId: fixtures.admin.id,
        resolveAmountCents: fetchStipendAmountCentsForPeriod,
        fromDate: parsePfaInput("2026-09-07", "00:00"),
      }),
    ).rejects.toThrow(/not the start of a pay period/i);
  });

  it("the sanctioned floor is PFA-midnight on 2026-09-01", () => {
    // PDT in September — 07:00Z. A `Z` literal hardcoded at 00:00 would pull
    // in the last 17 hours of August.
    expect(SANCTIONED_FLOOR.toISOString()).toBe("2026-09-01T07:00:00.000Z");
  });

  it("ignores logs before the floor entirely", async () => {
    const { admin, coach } = fixtures;
    await setCoachStipendInternal(
      admin,
      {
        coachId: coach.id,
        amountCents: STIPEND_CENTS,
        effectiveFrom: parsePfaInput("2026-08-01", "00:00"),
        confirmBackdate: true,
      },
      NOW,
    );
    const program = await createProgram(true);
    await seedUntriggeredLog({
      coachId: coach.id,
      programId: program.id,
      startAt: parsePfaInput("2026-08-05", "09:00"),
      endAt: parsePfaInput("2026-08-05", "11:00"),
    });

    const report = await backfillStipendEarnings({
      actorUserId: admin.id,
      resolveAmountCents: fetchStipendAmountCentsForPeriod,
      apply: true,
    });
    // 🔴 §12.4 — no earning before Sept 1, ever. Backdating further would
    // claim back-pay Mark may already have settled in cash.
    expect(report.counts.coveredLogsScanned).toBe(0);
    expect(await earningsFor(coach.id)).toHaveLength(0);
  });
});
