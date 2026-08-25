// APPROVING A COACH'S OWN LOG → THE SCHEDULE.
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
// Mark asked for the schedule to agree with the work log "once hours are
// posted or logged ON EITHER END". The admin end shipped 2026-08-25: an
// admin recording hours joins the coach to an overlapping block. THE COACH
// END DID NOT. A coach who covers somebody else's shift and logs it himself
// is HELD as `unscheduled`; approving that log posted the pay and left the
// block reading `wrong_coach` forever, because the coach who actually worked
// it was still not a member of it.
//
// That is the real Aug 8 shape: Lucas Milone scheduled for Front Desk
// 10:00–3:00, Tyler Garcia actually worked it, Tyler logged it himself, Mark
// approved it. Every admin action was correct and the block stayed red with
// no way to clear it.
//
// ── 🔴 WHAT THIS FEATURE MUST *NOT* DO, AND IT IS THE POINT OF THE FILE ──
// Adding Tyler MUST NOT clear Lucas. Lucas did not show up, and somebody
// else covering does not change that. The block must still read RED, Lucas
// must still read `no_show` — on the tile and on his accountability record —
// and Lucas must still be ON the block. A version of this feature that
// "makes the block green" is the wrong feature, and the tests below are
// written to fail loudly if anyone ever builds it.
//
// Isolation: the sync CREATES schedule blocks this file never asks for, so
// teardown deletes blocks BY PROGRAM rather than by tracked id (rule 47),
// and every test takes its own day in 2033, a year no other suite uses
// (rule 20).

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  auditLog,
  hourLogs,
  programScheduleBlockCoaches,
  programScheduleBlocks,
  programs,
  users,
  type User,
} from "@/db/schema";
import {
  acceptNeedsReviewLogInternal,
  approveHeldHourLogInternal,
  logHourInternal,
} from "@/lib/server/hour-log-actions";
import { createProgramScheduleBlockInternal } from "@/lib/server/program-schedule-actions";
import {
  reconcileBlocks,
  type ReconBlock,
  type ReconLog,
} from "@/lib/server/reconciliation";
import { formatPfaTime12h, parsePfaInput } from "@/lib/timezone";
import { ensureFixtureUsers, truncateMutables, type FixtureUsers } from "./fixtures";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

let fixtures: FixtureUsers;
let admin: FixtureUsers["admin"];

const createdProgramIds: string[] = [];
const createdUserIds: string[] = [];

// 2033 is claimed by no other suite. Each test takes the next day.
let dayCursor = 0;
function nextDay(): string {
  dayCursor += 1;
  const day = String((dayCursor % 27) + 1).padStart(2, "0");
  const month = String((Math.floor(dayCursor / 27) % 12) + 1).padStart(2, "0");
  return `2033-${month}-${day}`;
}

const at = (date: string, time: string) => parsePfaInput(date, time);

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createProgram(active = true): Promise<{ id: string }> {
  const [row] = await db
    .insert(programs)
    .values({
      name: `Approved Work Sync ${uniqueSuffix()}`,
      active,
      defaultRatePer30MinCents: 1500,
    })
    .returning({ id: programs.id });
  createdProgramIds.push(row.id);
  return row;
}

// Returns the FULL user row: these coaches are used as the ACTOR on
// `logHourInternal`, which takes an authed-session user.
async function createCoach(name: string): Promise<User> {
  const [row] = await db
    .insert(users)
    .values({
      email: `approved-sync-${uniqueSuffix()}@test.invalid`,
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
  startAt: Date;
  endAt: Date;
}): Promise<{ id: string }> {
  return createProgramScheduleBlockInternal(admin, {
    programId: opts.programId,
    scheduledCoachIds: opts.coachIds,
    startAt: opts.startAt,
    endAt: opts.endAt,
  });
}

async function memberIds(blockId: string): Promise<string[]> {
  const rows = await db
    .select({ coachId: programScheduleBlockCoaches.coachId })
    .from(programScheduleBlockCoaches)
    .where(eq(programScheduleBlockCoaches.blockId, blockId));
  return rows.map((r) => r.coachId);
}

/**
 * Rebuilds the reconciliation inputs the way `/admin/hour-log/schedule`
 * does — the block plus its FULL member set from the join table, and every
 * POSTED log of that program.
 *
 * 🔴 Re-derived from the DATABASE, never from what the test just wrote. The
 * property under test is a disagreement between what was written and what
 * the schedule renders, and a helper echoing the test's own inputs could not
 * see it (rule 26).
 */
async function reconcileFromDb(blockId: string, now: Date) {
  const [block] = await db
    .select()
    .from(programScheduleBlocks)
    .where(eq(programScheduleBlocks.id, blockId))
    .limit(1);
  if (!block) throw new Error(`block ${blockId} vanished`);

  const coachRows = await db
    .select({
      coachId: programScheduleBlockCoaches.coachId,
      coachName: users.name,
      coachEmail: users.email,
    })
    .from(programScheduleBlockCoaches)
    .innerJoin(users, eq(programScheduleBlockCoaches.coachId, users.id))
    .where(eq(programScheduleBlockCoaches.blockId, blockId));

  const reconBlock: ReconBlock = {
    id: block.id,
    programId: block.programId,
    scheduledCoachId: block.scheduledCoachId,
    scheduledCoachName:
      coachRows.find((c) => c.coachId === block.scheduledCoachId)?.coachName ??
      null,
    coaches: coachRows.map((c) => ({
      coachId: c.coachId,
      coachName: c.coachName ?? c.coachEmail,
    })),
    startAt: block.startAt,
    endAt: block.endAt,
  };

  const logRows = await db
    .select({
      coachId: hourLogs.coachId,
      coachName: users.name,
      coachEmail: users.email,
      programId: hourLogs.programId,
      startAt: hourLogs.startAt,
      endAt: hourLogs.endAt,
      status: hourLogs.status,
    })
    .from(hourLogs)
    .innerJoin(users, eq(hourLogs.coachId, users.id))
    .where(eq(hourLogs.programId, block.programId));

  // The schedule overlay is POSTED-only — 1b security B.
  const logs: ReconLog[] = logRows
    .filter((l) => l.status === "posted")
    .map((l) => ({
      coachId: l.coachId,
      coachName: l.coachName ?? l.coachEmail,
      programId: l.programId,
      startAt: l.startAt,
      endAt: l.endAt,
    }));

  return reconcileBlocks({ blocks: [reconBlock], logs, now }, formatPfaTime12h)[
    blockId
  ];
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
    // By PROGRAM, not by tracked id: this feature CREATES blocks the test
    // never asked for, and a missed one fails the program delete with a
    // 23503 that reads exactly like a product defect (rule 47).
    await db
      .delete(programScheduleBlocks)
      .where(inArray(programScheduleBlocks.programId, createdProgramIds));
    await db.delete(programs).where(inArray(programs.id, createdProgramIds));
    createdProgramIds.length = 0;
  }
  if (createdUserIds.length > 0) {
    // 🔴 audit_log BEFORE users. These coaches are ACTORS: logging their own
    // hours writes an audit row pinned to them by
    // `audit_log_actor_user_id_users_id_fk`, so deleting the user first dies
    // with a 23503 that fails every test around it and reads like a product
    // defect (rule 28, as a teardown ordering constraint).
    await db
      .delete(auditLog)
      .where(inArray(auditLog.actorUserId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
    createdUserIds.length = 0;
  }
});

/* ── THE AUG 8 SEQUENCE ──────────────────────────────────────────────────── */

describe("a coach covers someone else's shift and logs it himself", () => {
  it("adds the covering coach to the block, KEEPS the scheduled coach, and the block stays RED as a no-show", async () => {
    const program = await createProgram();
    const lucas = await createCoach("Lucas Milone");
    const tyler = await createCoach("Tyler Garcia");
    const day = nextDay();
    const startAt = at(day, "10:00");
    const endAt = at(day, "15:00");
    const now = at(day, "23:00"); // well past end + NO_SHOW_BUFFER_MS

    const block = await createBlock({
      programId: program.id,
      coachIds: [lucas.id],
      startAt,
      endAt,
    });

    // Tyler logs the shift HIMSELF. He is not on the block, so the
    // 1b-security-B gate holds it as `unscheduled`.
    const held = await logHourInternal(tyler, {
      programId: program.id,
      startAt,
      endAt,
      note: "Cleaning for Lucas Milone.",
      acknowledgeHold: true,
    });
    expect(held.status).toBe("held");
    expect(held.heldReason).toBe("unscheduled");

    // Mark approves it.
    const approved = await approveHeldHourLogInternal(admin, held.id);
    expect(approved.log.status).toBe("posted");
    expect(approved.schedule.kind).toBe("joined");

    // ── Tyler is ON the block now. ──
    const members = await memberIds(block.id);
    expect(members).toContain(tyler.id);

    // ── 🔴 AND SO IS LUCAS. This is the assertion that matters most in
    // this file: recording who covered must never delete the person who
    // was supposed to be there, because his no-show is the record.
    expect(members).toContain(lucas.id);
    expect(members).toHaveLength(2);

    // ── The block reads exactly what it should. ──
    const recon = await reconcileFromDb(block.id, now);
    const byCoach = Object.fromEntries(
      recon.coaches.map((c) => [c.coachId, c.status]),
    );
    expect(byCoach[tyler.id]).toBe("logged");
    expect(byCoach[lucas.id]).toBe("no_show");

    // The tile is RED — the aggregate is red if ANY member has a problem.
    expect(recon.status).toBe("no_show");

    // And `wrong_coach` is gone: it means "somebody NOT on this block
    // logged it", which stopped being true the moment Tyler joined.
    expect(recon.coaches.map((c) => c.status)).not.toContain("wrong_coach");
  });

  it("CONTROL — the same log posted WITHOUT the coach joining the block reads wrong_coach, which is the state this feature removes", async () => {
    // 🔴 The positive control for the negative assertion above (rule 15).
    // Without it, "not wrong_coach" could pass for any reason at all —
    // including the block having no coaches, or the log never posting.
    const program = await createProgram();
    const lucas = await createCoach("Lucas Control");
    const tyler = await createCoach("Tyler Control");
    const day = nextDay();
    const startAt = at(day, "10:00");
    const endAt = at(day, "15:00");
    const now = at(day, "23:00");

    const block = await createBlock({
      programId: program.id,
      coachIds: [lucas.id],
      startAt,
      endAt,
    });

    const held = await logHourInternal(tyler, {
      programId: program.id,
      startAt,
      endAt,
      note: "covering",
      acknowledgeHold: true,
    });
    await approveHeldHourLogInternal(admin, held.id);

    // Undo ONLY the membership the sync added, leaving the posted log in
    // place — i.e. the exact world before this feature existed.
    await db
      .delete(programScheduleBlockCoaches)
      .where(
        and(
          eq(programScheduleBlockCoaches.blockId, block.id),
          eq(programScheduleBlockCoaches.coachId, tyler.id),
        ),
      );

    const recon = await reconcileFromDb(block.id, now);
    expect(recon.coaches.map((c) => c.status)).toContain("wrong_coach");
  });

  it("creates a block when the covered work had none scheduled at all", async () => {
    const program = await createProgram();
    const tyler = await createCoach("Tyler Unscheduled");
    const day = nextDay();
    const startAt = at(day, "10:00");
    const endAt = at(day, "12:00");

    const held = await logHourInternal(tyler, {
      programId: program.id,
      startAt,
      endAt,
      note: "nobody was scheduled",
      acknowledgeHold: true,
    });
    const approved = await approveHeldHourLogInternal(admin, held.id);
    expect(approved.schedule.kind).toBe("created");

    const blocks = await db
      .select()
      .from(programScheduleBlocks)
      .where(eq(programScheduleBlocks.programId, program.id));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].startAt.getTime()).toBe(startAt.getTime());
    expect(blocks[0].endAt.getTime()).toBe(endAt.getTime());
    expect(await memberIds(blocks[0].id)).toEqual([tyler.id]);
  });
});

/* ── THE RESTRAINTS ──────────────────────────────────────────────────────── */

describe("what approving must never do to the schedule", () => {
  it("NEVER moves an existing block's window, even when the approved log has different times", async () => {
    // 🔴 `isOverLogged` compares a log against ITS BLOCK's window. A block
    // that reshaped itself to fit whatever was logged would make that
    // comparison zero by construction and retire the hours-overclaim alarm
    // permanently. Adding a PERSON leaves the window alone.
    const program = await createProgram();
    const lucas = await createCoach("Lucas Window");
    const tyler = await createCoach("Tyler Window");
    const day = nextDay();
    const blockStart = at(day, "10:00");
    const blockEnd = at(day, "15:00");

    const block = await createBlock({
      programId: program.id,
      coachIds: [lucas.id],
      startAt: blockStart,
      endAt: blockEnd,
    });

    // Overlapping but NOT the same window — 11:00 to 18:00.
    const held = await logHourInternal(tyler, {
      programId: program.id,
      startAt: at(day, "11:00"),
      endAt: at(day, "18:00"),
      note: "ran long",
      acknowledgeHold: true,
    });
    await approveHeldHourLogInternal(admin, held.id);

    const [after] = await db
      .select()
      .from(programScheduleBlocks)
      .where(eq(programScheduleBlocks.id, block.id));
    expect(after.startAt.getTime()).toBe(blockStart.getTime());
    expect(after.endAt.getTime()).toBe(blockEnd.getTime());
  });

  it("still posts and pays the hours when the schedule cannot be updated", async () => {
    // 🔴 The sync runs AFTER the pay is written and can never un-write it,
    // so it reports failure instead of raising it. An admin's own held log
    // has a non-schedulable subject (only role=coach may sit on a block),
    // which is the reachable version of that.
    const program = await createProgram();
    const day = nextDay();
    const startAt = at(day, "10:00");
    const endAt = at(day, "12:00");

    const held = await logHourInternal(admin, {
      programId: program.id,
      startAt,
      endAt,
      note: "Mark's own work log",
      acknowledgeHold: true,
    });
    const approved = await approveHeldHourLogInternal(admin, held.id);

    // The money landed regardless.
    expect(approved.log.status).toBe("posted");
    const [row] = await db
      .select()
      .from(hourLogs)
      .where(eq(hourLogs.id, held.id));
    expect(row.status).toBe("posted");

    // And the skip is REPORTED, not silent.
    expect(approved.schedule.kind).toBe("skipped");
    if (approved.schedule.kind === "skipped") {
      expect(approved.schedule.reason).toBe("not_schedulable");
      expect(approved.schedule.detail).toMatch(/recorded/i);
    }

    // No block was invented for a non-coach.
    const blocks = await db
      .select()
      .from(programScheduleBlocks)
      .where(eq(programScheduleBlocks.programId, program.id));
    expect(blocks).toHaveLength(0);
  });
});

/* ── THE NEEDS-REVIEW SIBLING ────────────────────────────────────────────── */

describe("accepting a needs-review log", () => {
  it("joins the coach to the block once the admin accepts the work", async () => {
    const program = await createProgram();
    const lucas = await createCoach("Lucas Accept");
    const tyler = await createCoach("Tyler Accept");
    const day = nextDay();
    const startAt = at(day, "10:00");
    const endAt = at(day, "15:00");

    const block = await createBlock({
      programId: program.id,
      coachIds: [lucas.id],
      startAt,
      endAt,
    });

    const held = await logHourInternal(tyler, {
      programId: program.id,
      startAt,
      endAt,
      note: "covering",
      acknowledgeHold: true,
    });
    // Post it without the approval path, then take Tyler back off the
    // block, so the accept path is the only thing that can put him on it.
    await approveHeldHourLogInternal(admin, held.id);
    await db
      .delete(programScheduleBlockCoaches)
      .where(
        and(
          eq(programScheduleBlockCoaches.blockId, block.id),
          eq(programScheduleBlockCoaches.coachId, tyler.id),
        ),
      );
    expect(await memberIds(block.id)).not.toContain(tyler.id);

    const accepted = await acceptNeedsReviewLogInternal(admin, held.id, {
      startAt,
      endAt,
    });
    expect(accepted.schedule?.kind).toBe("joined");
    expect(await memberIds(block.id)).toContain(tyler.id);
    // Lucas is untouched, same as every other path.
    expect(await memberIds(block.id)).toContain(lucas.id);
  });

  it("reports schedule:null on the idempotent no-op, which is NOT the same as 'ran and changed nothing'", async () => {
    const program = await createProgram();
    const tyler = await createCoach("Tyler Idempotent");
    const day = nextDay();
    const startAt = at(day, "10:00");
    const endAt = at(day, "12:00");

    const held = await logHourInternal(tyler, {
      programId: program.id,
      startAt,
      endAt,
      note: "once",
      acknowledgeHold: true,
    });
    await approveHeldHourLogInternal(admin, held.id);

    // Already posted + reviewed, and no edit → the early return.
    const again = await acceptNeedsReviewLogInternal(admin, held.id);
    expect(again.schedule).toBeNull();
  });
});
