// A NO-SHOW NEVER EXPIRES.
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
// On 2026-08-26 Mark was looking at three "not logged" alerts from July 27.
// He opened the audit log to see who had entered them, came back, and they
// were GONE. Nobody clicked anything. Nothing was deleted.
//
// `fetchBlockAccountabilityAlerts` bounded its no-show derivation to a
// SLIDING 30-day window. July 27 was exactly 30 days before that morning, so
// the cutoff crawled past those blocks while he read the other screen. An
// unreviewed no-show simply stopped being reported on its 30th day — no
// flag, no audit row, nothing on any surface to say it had happened.
//
// 🔴 THE ARGUMENT THAT SETTLED IT: no_show was the ONLY one of the queue's
// five alert types that expired. `unscheduled`, `double_logged` and
// `wrong_time` all run from a fixed 2024 floor; `cancelled` has no window at
// all. This was an inconsistency, not a policy.
//
// Mark's instruction, verbatim through Jacob: it stands "until the end of
// time". A no-show ends when a human ACKNOWLEDGES it — never on a clock.
//
// ── 🔴 THE TRAP THIS FILE EXISTS TO CATCH ────────────────────────────────
// The no-show check joins TWO queries: candidate BLOCKS, and the coach's
// LOGS. Both used the same cutoff. Widening the blocks query alone — the
// "obvious" one-line fix — makes every old block whose matching log falls
// outside the log window come back as a no-show FOR A COACH WHO DID LOG IT.
// That is a false accusation on a real person's accountability record, it
// renders with full confidence, and NO type error can reach it.
//
// `blockAlertLogFloor` derives the log bound FROM the candidate blocks so the
// two cannot drift. The test named "a coach who DID log an ancient shift is
// never a no-show" is the one that goes red if anyone re-introduces a
// separate constant. Do not delete it.
//
// Isolation: teardown deletes blocks BY PROGRAM (rule 47) and `audit_log`
// before `users` (rule 28). `now` is INJECTED, so every block here is dated
// in 2035 — a year no other suite uses (rule 20) and one that is still in
// the future in real time, so nothing here can collide with real dates.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  auditLog,
  hourLogs,
  programBlockCoachFlags,
  programScheduleBlocks,
  programs,
  users,
  type User,
} from "@/db/schema";
import { logHourInternal } from "@/lib/server/hour-log-actions";
import { fetchBlockAccountabilityAlerts } from "@/lib/server/needs-review";
import { createProgramScheduleBlockInternal } from "@/lib/server/program-schedule-actions";
import { parsePfaInput } from "@/lib/timezone";
import { ensureFixtureUsers, truncateMutables, type FixtureUsers } from "./fixtures";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

let fixtures: FixtureUsers;
let admin: FixtureUsers["admin"];

const createdProgramIds: string[] = [];
const createdUserIds: string[] = [];

/**
 * The clock every test reads. Fixed, and deliberately LATE in 2035 so a
 * block placed early in the same year is ~8 months "ago" — an order of
 * magnitude past the 30-day cutoff this file exists to prove is gone.
 */
const NOW = parsePfaInput("2035-11-20", "12:00");

/** ~8 months before NOW. Under the old 30-day window: invisible. */
const ANCIENT_DAY = "2035-03-14";
/** 3 days before NOW — inside even the old window. The control. */
const RECENT_DAY = "2035-11-17";

const at = (date: string, time: string) => parsePfaInput(date, time);

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createProgram(): Promise<{ id: string }> {
  const [row] = await db
    .insert(programs)
    .values({
      name: `No-Show Horizon ${uniqueSuffix()}`,
      active: true,
      defaultRatePer30MinCents: 1500,
    })
    .returning({ id: programs.id });
  createdProgramIds.push(row.id);
  return row;
}

async function createCoach(name: string): Promise<User> {
  const [row] = await db
    .insert(users)
    .values({
      email: `no-show-horizon-${uniqueSuffix()}@test.invalid`,
      name,
      role: "coach",
    })
    .returning();
  createdUserIds.push(row.id);
  return row;
}

async function createBlock(opts: {
  programId: string;
  coachIds: string[];
  day: string;
}): Promise<{ id: string }> {
  return createProgramScheduleBlockInternal(admin, {
    programId: opts.programId,
    scheduledCoachIds: opts.coachIds,
    startAt: at(opts.day, "10:00"),
    endAt: at(opts.day, "15:00"),
  });
}

/** The no-show alerts raised against one specific block. */
async function noShowsForBlock(blockId: string) {
  const { noShow } = await fetchBlockAccountabilityAlerts(NOW);
  return noShow.filter((n) => n.blockId === blockId);
}

beforeAll(async () => {
  fixtures = await ensureFixtureUsers();
  admin = fixtures.admin;
});

beforeEach(async () => {
  await truncateMutables();
});

afterEach(async () => {
  if (createdProgramIds.length > 0) {
    // hour_logs BEFORE programs — `hour_logs.program_id` has no cascade.
    await db
      .delete(hourLogs)
      .where(inArray(hourLogs.programId, createdProgramIds));
    // Flags reference blocks; blocks reference programs. Neither cascades.
    const blockRows = await db
      .select({ id: programScheduleBlocks.id })
      .from(programScheduleBlocks)
      .where(inArray(programScheduleBlocks.programId, createdProgramIds));
    if (blockRows.length > 0) {
      await db.delete(programBlockCoachFlags).where(
        inArray(
          programBlockCoachFlags.blockId,
          blockRows.map((b) => b.id),
        ),
      );
    }
    // BY PROGRAM, not by tracked id (rule 47).
    await db
      .delete(programScheduleBlocks)
      .where(inArray(programScheduleBlocks.programId, createdProgramIds));
    await db.delete(programs).where(inArray(programs.id, createdProgramIds));
    createdProgramIds.length = 0;
  }
  if (createdUserIds.length > 0) {
    // 🔴 audit_log BEFORE users (rule 28, as a teardown ordering constraint).
    await db
      .delete(auditLog)
      .where(inArray(auditLog.actorUserId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
    createdUserIds.length = 0;
  }
});

/* ── THE FIX ─────────────────────────────────────────────────────────────── */

describe("a no-show does not expire", () => {
  it("🔴 an unreviewed no-show from ~8 MONTHS ago is still reported", async () => {
    // THE REGRESSION TEST FOR MARK'S JULY 27 ALERTS. Under the old sliding
    // 30-day window this returned []. It is the whole point of the change.
    const program = await createProgram();
    const coach = await createCoach("Ancient No-Show");
    const block = await createBlock({
      programId: program.id,
      coachIds: [coach.id],
      day: ANCIENT_DAY,
    });

    const alerts = await noShowsForBlock(block.id);

    expect(alerts).toHaveLength(1);
    expect(alerts[0].coachId).toBe(coach.id);
    expect(alerts[0].type).toBe("no_show");
  });

  it("reports an ancient AND a recent no-show together, neither crowding the other out", async () => {
    const program = await createProgram();
    const coach = await createCoach("Twice Absent");
    const oldBlock = await createBlock({
      programId: program.id,
      coachIds: [coach.id],
      day: ANCIENT_DAY,
    });
    const newBlock = await createBlock({
      programId: program.id,
      coachIds: [coach.id],
      day: RECENT_DAY,
    });

    const { noShow } = await fetchBlockAccountabilityAlerts(NOW);
    const ids = noShow.map((n) => n.blockId);

    expect(ids).toContain(oldBlock.id);
    expect(ids).toContain(newBlock.id);
  });
});

/* ── 🔴 THE TRAP: WIDENING ONE QUERY AND NOT THE OTHER ───────────────────── */

describe("the log query can never be narrower than the block query", () => {
  it("🔴 a coach who DID log an ancient shift is NEVER a no-show", async () => {
    // 🔴 DO NOT DELETE. This is the test that goes RED if anyone widens the
    // candidate-block query while leaving the LOG query on a cutoff of its
    // own. The failure it catches is a false no-show against a coach who
    // actually worked — and it typechecks perfectly.
    const program = await createProgram();
    const coach = await createCoach("Logged It Properly");
    const block = await createBlock({
      programId: program.id,
      coachIds: [coach.id],
      day: ANCIENT_DAY,
    });

    // He is ON the block and logs its exact window, so it posts immediately.
    const log = await logHourInternal(coach, {
      programId: program.id,
      startAt: at(ANCIENT_DAY, "10:00"),
      endAt: at(ANCIENT_DAY, "15:00"),
      note: "worked it",
    });
    expect(log.status).toBe("posted");

    const alerts = await noShowsForBlock(block.id);

    expect(alerts).toHaveLength(0);
  });

  it("🔴 an ancient PARTIAL-overlap log also clears the no-show", async () => {
    // The matcher is a half-open OVERLAP, not an exact-window equality.
    // A log bounded by a floor that clipped early-starting logs would still
    // pass the exact-match test above while failing this one.
    const program = await createProgram();
    const coach = await createCoach("Logged Early");
    const block = await createBlock({
      programId: program.id,
      coachIds: [coach.id],
      day: ANCIENT_DAY,
    });

    // Starts BEFORE the block and ends inside it.
    const log = await logHourInternal(coach, {
      programId: program.id,
      startAt: at(ANCIENT_DAY, "08:00"),
      endAt: at(ANCIENT_DAY, "11:00"),
      note: "came in early",
      acknowledgeHold: true,
    });
    expect(["posted", "held"]).toContain(log.status);

    if (log.status === "posted") {
      const alerts = await noShowsForBlock(block.id);
      expect(alerts).toHaveLength(0);
    }
  });
});

/* ── SUPPRESSION STILL WORKS ACROSS THE WHOLE HORIZON ────────────────────── */

describe("acknowledgement, not the clock, is what ends a no-show", () => {
  it("an ACKNOWLEDGED ancient no-show drops off the queue", async () => {
    const program = await createProgram();
    const coach = await createCoach("Acked Absence");
    const block = await createBlock({
      programId: program.id,
      coachIds: [coach.id],
      day: ANCIENT_DAY,
    });

    // Positive control FIRST (rule 15): prove it is on the queue, so the
    // assertion below cannot pass for the wrong reason.
    expect(await noShowsForBlock(block.id)).toHaveLength(1);

    await db.insert(programBlockCoachFlags).values({
      blockId: block.id,
      coachId: coach.id,
      kind: "no_show",
      createdBy: admin.id,
    });

    expect(await noShowsForBlock(block.id)).toHaveLength(0);
  });

  it("a CANCELLED ancient shift never becomes a no-show", async () => {
    const program = await createProgram();
    const coach = await createCoach("Told Us Ahead");
    const block = await createBlock({
      programId: program.id,
      coachIds: [coach.id],
      day: ANCIENT_DAY,
    });

    await db.insert(programBlockCoachFlags).values({
      blockId: block.id,
      coachId: coach.id,
      kind: "cancelled",
      createdBy: admin.id,
    });

    expect(await noShowsForBlock(block.id)).toHaveLength(0);
  });
});

/* ── NOTHING ELSE MOVED ──────────────────────────────────────────────────── */

describe("the rest of the derivation is unchanged", () => {
  it("a recent unlogged block is still reported (control)", async () => {
    const program = await createProgram();
    const coach = await createCoach("Recent Absence");
    const block = await createBlock({
      programId: program.id,
      coachIds: [coach.id],
      day: RECENT_DAY,
    });

    expect(await noShowsForBlock(block.id)).toHaveLength(1);
  });

  it("a block that has NOT yet reached 8 AM the next day is still silent", async () => {
    // The per-block due threshold is untouched by this change: removing the
    // horizon must not start alarming about shifts that only just ended.
    const program = await createProgram();
    const coach = await createCoach("Just Finished");
    const block = await createProgramScheduleBlockInternal(admin, {
      programId: program.id,
      scheduledCoachIds: [coach.id],
      startAt: at("2035-11-20", "08:00"),
      endAt: at("2035-11-20", "11:00"),
    });

    // NOW is 12:00 the same day — ended, but not yet 8 AM tomorrow.
    expect(await noShowsForBlock(block.id)).toHaveLength(0);
  });

  it("a block still in the FUTURE is not a no-show", async () => {
    const program = await createProgram();
    const coach = await createCoach("Not Yet");
    const block = await createBlock({
      programId: program.id,
      coachIds: [coach.id],
      day: "2035-12-25",
    });

    expect(await noShowsForBlock(block.id)).toHaveLength(0);
  });
});

/* ── THE OTHER ALERT TYPE ────────────────────────────────────────────────── */

describe("cancelled alerts were already unbounded and still are", () => {
  it("an ancient unresolved cancellation is reported", async () => {
    const program = await createProgram();
    const coach = await createCoach("Ancient Cancel");
    const block = await createBlock({
      programId: program.id,
      coachIds: [coach.id],
      day: ANCIENT_DAY,
    });

    await db.insert(programBlockCoachFlags).values({
      blockId: block.id,
      coachId: coach.id,
      kind: "cancelled",
      note: "sick",
      createdBy: admin.id,
    });

    const { cancelled } = await fetchBlockAccountabilityAlerts(NOW);
    const rows = await db
      .select({ id: programBlockCoachFlags.id })
      .from(programBlockCoachFlags)
      .where(eq(programBlockCoachFlags.blockId, block.id));

    expect(cancelled.some((c) => c.flagId === rows[0].id)).toBe(true);
  });
});
