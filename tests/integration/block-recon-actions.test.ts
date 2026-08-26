// Integration tests for src/lib/server/block-reassign-actions.ts — open item
// 0r(1), the admin substitute-coach reassign. Hits the real Neon dev branch.
// Same direct-internal pattern as block-handoff-actions.test.ts: call the
// *Internal export with a synthetic admin actor; the public "use server"
// wrapper adds only requireRole("admin") + revalidatePath.
//
// The case these exist for: Lucas Milone was scheduled Front Desk Sat Aug 8
// 10:00–3:00 and Tyler Garcia actually worked it. Tyler logged it, Mark
// approved it and deleted Lucas's log — every action correct — and the block
// still rendered red forever, because `wrong_coach` is derived on every
// render and nothing could clear it.
//
// The last test is the one that matters most: it enters at the TOP of the
// pipeline (real rows → reconcileBlocks) and proves the status actually goes
// GREEN afterwards, rather than proving the membership table changed and
// assuming the rest (discipline rule 26).

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  auditLog,
  hourLogs,
  programScheduleBlockCoaches,
  programScheduleBlocks,
  programs,
  users,
} from "@/db/schema";
import { createProgramScheduleBlockInternal } from "@/lib/server/program-schedule-actions";
import { matchBlockToLoggedTimesInternal } from "@/lib/server/block-recon-actions";
import { reconcileBlocks } from "@/lib/server/reconciliation";
import {
  BlockNotWrongTimeError,
  MultiCoachBlockTimeMatchError,
  NotAssignedToBlockError,
  ProgramScheduleBlockNotFoundError,
} from "@/lib/errors";
import {
  ensureFixtureUsers,
  truncateMutables,
  type FixtureUsers,
} from "./fixtures";
import type { AuthedSession } from "@/lib/authz";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

let fixtures: FixtureUsers;

const createdBlockIds: string[] = [];
const createdProgramIds: string[] = [];
const createdUserIds: string[] = [];
const createdHourLogIds: string[] = [];

beforeAll(async () => {
  fixtures = await ensureFixtureUsers();
});

beforeEach(async () => {
  await truncateMutables();
});

afterEach(async () => {
  if (createdHourLogIds.length > 0) {
    await db.delete(hourLogs).where(inArray(hourLogs.id, createdHourLogIds));
    createdHourLogIds.length = 0;
  }
  if (createdBlockIds.length > 0) {
    await db
      .delete(programScheduleBlocks)
      .where(inArray(programScheduleBlocks.id, createdBlockIds));
    createdBlockIds.length = 0;
  }
});

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createProgram(): Promise<{ id: string }> {
  const [row] = await db
    .insert(programs)
    .values({ name: `Reassign Test Program ${uniqueSuffix()}`, active: true })
    .returning({ id: programs.id });
  createdProgramIds.push(row.id);
  return row;
}

async function createCoach(opts?: {
  role?: "coach" | "admin";
  deleted?: boolean;
  name?: string;
}): Promise<{ id: string }> {
  const [row] = await db
    .insert(users)
    .values({
      email: `reassign-${uniqueSuffix()}@test.invalid`,
      name: opts?.name ?? "Reassign Coach",
      role: opts?.role ?? "coach",
      deletedAt: opts?.deleted ? new Date() : null,
    })
    .returning({ id: users.id });
  createdUserIds.push(row.id);
  return row;
}

// UTC hour offset from today, so blocks can sit in the past (the Aug 8
// shape) without depending on the runner's clock beyond the day.
function daysFromNowAt(dayOffset: number, hour: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + dayOffset);
  d.setUTCHours(hour, 0, 0, 0);
  return d;
}

async function createBlock(opts: {
  programId: string;
  coachIds: string[];
  startAt: Date;
  endAt: Date;
}): Promise<{ id: string; scheduledCoachId: string | null }> {
  const block = await createProgramScheduleBlockInternal(fixtures.admin, {
    programId: opts.programId,
    scheduledCoachIds: opts.coachIds,
    startAt: opts.startAt,
    endAt: opts.endAt,
  });
  createdBlockIds.push(block.id);
  return { id: block.id, scheduledCoachId: block.scheduledCoachId };
}

async function insertLog(
  coachId: string,
  programId: string,
  startAt: Date,
  endAt: Date,
  status: "posted" | "held" = "posted",
): Promise<string> {
  const [row] = await db
    .insert(hourLogs)
    .values({ coachId, programId, startAt, endAt, status, createdBy: coachId })
    .returning({ id: hourLogs.id });
  createdHourLogIds.push(row.id);
  return row.id;
}

function adminActor(): AuthedSession["user"] {
  return fixtures.admin;
}

// The Aug 8 shape, ready to reassign: scheduled coach on the block, the
// substitute holding the only posted log for the same program + window.
async function aug8Setup() {
  const program = await createProgram();
  const scheduled = await createCoach({ name: "Lucas Milone" });
  const substitute = await createCoach({ name: "Tyler Garcia" });
  const startAt = daysFromNowAt(-3, 17);
  const endAt = daysFromNowAt(-3, 22);
  const block = await createBlock({
    programId: program.id,
    coachIds: [scheduled.id],
    startAt,
    endAt,
  });
  const logId = await insertLog(substitute.id, program.id, startAt, endAt);
  return { program, scheduled, substitute, block, startAt, endAt, logId };
}


// Runs the REAL engine over one block's live rows — used to prove the red
// actually clears, rather than proving a table changed and assuming the rest
// (discipline rule 26).
const fmt = (d: Date) => d.toISOString().slice(11, 16);

async function reconcileOne(blockId: string, programId: string) {
  const [b] = await db
    .select()
    .from(programScheduleBlocks)
    .where(eq(programScheduleBlocks.id, blockId));
  const coachRows = await db
    .select({
      coachId: programScheduleBlockCoaches.coachId,
      coachName: users.name,
    })
    .from(programScheduleBlockCoaches)
    .innerJoin(users, eq(users.id, programScheduleBlockCoaches.coachId))
    .where(eq(programScheduleBlockCoaches.blockId, blockId));
  const logRows = await db
    .select({
      coachId: hourLogs.coachId,
      coachName: users.name,
      programId: hourLogs.programId,
      startAt: hourLogs.startAt,
      endAt: hourLogs.endAt,
    })
    .from(hourLogs)
    .innerJoin(users, eq(users.id, hourLogs.coachId))
    .where(eq(hourLogs.programId, programId));

  return reconcileBlocks(
    {
      blocks: [
        {
          id: b.id,
          programId: b.programId,
          scheduledCoachId: b.scheduledCoachId,
          scheduledCoachName:
            coachRows.find((c) => c.coachId === b.scheduledCoachId)
              ?.coachName ?? null,
          coaches: coachRows.map((c) => ({
            coachId: c.coachId,
            coachName: c.coachName ?? "",
          })),
          startAt: b.startAt,
          endAt: b.endAt,
        },
      ],
      logs: logRows.map((l) => ({
        coachId: l.coachId,
        coachName: l.coachName ?? "",
        programId: l.programId,
        startAt: l.startAt,
        endAt: l.endAt,
      })),
      now: new Date(),
    },
    fmt,
  );
}

// 📌 THE REASSIGN TESTS (three describes, ~325 lines) WERE REMOVED WITH THE
// ACTION ON 2026-08-25. They covered `reassignBlockToLoggedCoachInternal` —
// the happy path, its guards, and that the status actually went green. The
// action was retired because approving a coach's own log now JOINS him to
// the block, so `wrong_coach` no longer arises from the ordinary flow, and
// the action's removal half deleted the scheduled coach along with his
// `no_show`. ▶ `block-recon-actions.ts`'s header, and
// `schedule-follows-approved-work.test.ts` for what replaced the behaviour.

// 0r(4) — "match the schedule to what happened", the wrong_time resolution.
// The live case it was built for: Lucas, Sat Aug 22, logged 10:00–1:00
// against a scheduled 10:00–3:00. Right coach, wrong window — so there is
// nobody to hand it to; the block moves instead.
describe("matchBlockToLoggedTimesInternal", () => {
  // Scheduled 17:00–22:00 UTC, coach logged 17:00–20:00 — three hours short,
  // well outside the ±15-min tolerance.
  async function aug22Setup() {
    const program = await createProgram();
    const coach = await createCoach({ name: "Lucas Milone" });
    const startAt = daysFromNowAt(-2, 17);
    const endAt = daysFromNowAt(-2, 22);
    const loggedEnd = daysFromNowAt(-2, 20);
    const block = await createBlock({
      programId: program.id,
      coachIds: [coach.id],
      startAt,
      endAt,
    });
    await insertLog(coach.id, program.id, startAt, loggedEnd);
    return { program, coach, block, startAt, endAt, loggedEnd };
  }

  async function blockWindow(blockId: string) {
    const [row] = await db
      .select({
        startAt: programScheduleBlocks.startAt,
        endAt: programScheduleBlocks.endAt,
      })
      .from(programScheduleBlocks)
      .where(eq(programScheduleBlocks.id, blockId));
    return row;
  }

  it("moves the block onto the logged window", async () => {
    const { coach, block, startAt, loggedEnd } = await aug22Setup();

    const result = await matchBlockToLoggedTimesInternal(adminActor(), {
      blockId: block.id,
      coachId: coach.id,
    });

    expect(result.blockId).toBe(block.id);
    const w = await blockWindow(block.id);
    expect(w.startAt.getTime()).toBe(startAt.getTime());
    expect(w.endAt.getTime()).toBe(loggedEnd.getTime());
  });

  it("does NOT touch the hour log — pay cannot move", async () => {
    const { coach, block, program } = await aug22Setup();
    const before = await db
      .select()
      .from(hourLogs)
      .where(eq(hourLogs.programId, program.id));

    await matchBlockToLoggedTimesInternal(adminActor(), {
      blockId: block.id,
      coachId: coach.id,
    });

    const after = await db
      .select()
      .from(hourLogs)
      .where(eq(hourLogs.programId, program.id));
    expect(after).toEqual(before);
  });

  it("audits the move with the ORIGINAL window in `before`", async () => {
    const { coach, block, endAt } = await aug22Setup();
    await matchBlockToLoggedTimesInternal(adminActor(), {
      blockId: block.id,
      coachId: coach.id,
    });

    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, block.id));
    const update = rows.find((r) => r.action === "update");
    expect(update).toBeDefined();
    // The scheduled window is only preserved here, so this assertion is the
    // thing that makes "the original times are not lost" true.
    const diff = update!.diff as { before: Record<string, unknown> };
    expect(new Date(diff.before.endAt as string).getTime()).toBe(
      endAt.getTime(),
    );
  });

  // Rule 26 — enter at the top of the pipeline: prove the RED CLEARS.
  it("red before, green after, through the real engine", async () => {
    const { program, coach, block } = await aug22Setup();

    const before = await reconcileOne(block.id, program.id);
    expect(before[block.id].status).toBe("wrong_time");
    expect(before[block.id].coaches[0].loggedWindow).not.toBeNull();

    await matchBlockToLoggedTimesInternal(adminActor(), {
      blockId: block.id,
      coachId: coach.id,
    });

    const after = await reconcileOne(block.id, program.id);
    expect(after[block.id].status).toBe("logged");
    expect(after[block.id].coaches[0].loggedWindow).toBeNull();
  });

  it("refuses when the block is NOT wrong_time (the coach logged on time)", async () => {
    const program = await createProgram();
    const coach = await createCoach();
    const startAt = daysFromNowAt(-2, 17);
    const endAt = daysFromNowAt(-2, 22);
    const block = await createBlock({
      programId: program.id,
      coachIds: [coach.id],
      startAt,
      endAt,
    });
    await insertLog(coach.id, program.id, startAt, endAt);

    await expect(
      matchBlockToLoggedTimesInternal(adminActor(), {
        blockId: block.id,
        coachId: coach.id,
      }),
    ).rejects.toBeInstanceOf(BlockNotWrongTimeError);
  });

  it("refuses when the coach logged NOTHING (a no-show is not a time problem)", async () => {
    const program = await createProgram();
    const coach = await createCoach();
    const block = await createBlock({
      programId: program.id,
      coachIds: [coach.id],
      startAt: daysFromNowAt(-2, 17),
      endAt: daysFromNowAt(-2, 22),
    });

    await expect(
      matchBlockToLoggedTimesInternal(adminActor(), {
        blockId: block.id,
        coachId: coach.id,
      }),
    ).rejects.toBeInstanceOf(BlockNotWrongTimeError);
  });

  it("refuses when only ANOTHER coach logged it (that is wrong_coach)", async () => {
    const { substitute, scheduled, block } = await aug8Setup();
    await expect(
      matchBlockToLoggedTimesInternal(adminActor(), {
        blockId: block.id,
        coachId: scheduled.id,
      }),
    ).rejects.toBeInstanceOf(BlockNotWrongTimeError);
    expect(substitute.id).toBeTruthy();
  });

  // The guard with the widest blast radius: moving a shared block's window
  // to fit one coach silently re-reconciles it for everyone else on it.
  it("refuses on a block with MORE THAN ONE scheduled coach", async () => {
    const program = await createProgram();
    const a = await createCoach();
    const b = await createCoach();
    const startAt = daysFromNowAt(-2, 17);
    const endAt = daysFromNowAt(-2, 22);
    const block = await createBlock({
      programId: program.id,
      coachIds: [a.id, b.id],
      startAt,
      endAt,
    });
    await insertLog(a.id, program.id, startAt, daysFromNowAt(-2, 20));

    await expect(
      matchBlockToLoggedTimesInternal(adminActor(), {
        blockId: block.id,
        coachId: a.id,
      }),
    ).rejects.toBeInstanceOf(MultiCoachBlockTimeMatchError);
    // Untouched by the refusal.
    const w = await blockWindow(block.id);
    expect(w.endAt.getTime()).toBe(endAt.getTime());
  });

  it("refuses when the coach is not scheduled on the block", async () => {
    const { block } = await aug22Setup();
    const outsider = await createCoach();
    await expect(
      matchBlockToLoggedTimesInternal(adminActor(), {
        blockId: block.id,
        coachId: outsider.id,
      }),
    ).rejects.toBeInstanceOf(NotAssignedToBlockError);
  });

  it("refuses an unknown block", async () => {
    const { coach } = await aug22Setup();
    await expect(
      matchBlockToLoggedTimesInternal(adminActor(), {
        blockId: "00000000-0000-0000-0000-000000000000",
        coachId: coach.id,
      }),
    ).rejects.toBeInstanceOf(ProgramScheduleBlockNotFoundError);
  });
});
