// Integration tests for src/lib/server/block-handoff-actions.ts (W3-handoff).
// Hits the real Neon dev branch. Same direct-internal pattern as the other
// suites — call the *Internal exports with a synthetic coach actor; the
// public "use server" wrappers add only requireSession + revalidatePath.
//
// Seeds blocks via createProgramScheduleBlockInternal (so membership + audit
// match production), then exercises hand-off (reassign) + no-cover (cancel).
// truncateMutables does NOT touch programs/users/program_schedule_blocks, so
// each test makes its own with unique suffixes; created blocks are deleted in
// afterEach (CASCADE removes their coach-set + flags), and created hour_logs
// are deleted too. audit_log IS truncated between tests.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  auditLog,
  hourLogs,
  programBlockCoachFlags,
  programScheduleBlockCoaches,
  programScheduleBlocks,
  programs,
  users,
} from "@/db/schema";
import { createProgramScheduleBlockInternal } from "@/lib/server/program-schedule-actions";
import {
  cancelOwnBlockInternal,
  reassignOwnBlockInternal,
} from "@/lib/server/block-handoff-actions";
import { fetchBlockAccountabilityAlerts } from "@/lib/server/needs-review";
import {
  BlockAlreadyLoggedError,
  InvalidHandoffTargetError,
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
  // Truncates audit_log (+ other mutable tables) so per-test audit
  // assertions start clean; leaves our created programs/blocks/users/logs.
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
    .values({ name: `Handoff Test Program ${uniqueSuffix()}`, active: true })
    .returning({ id: programs.id });
  createdProgramIds.push(row.id);
  return row;
}

async function createCoach(opts?: {
  role?: "coach" | "admin";
  deleted?: boolean;
}): Promise<{ id: string }> {
  const [row] = await db
    .insert(users)
    .values({
      email: `handoff-${uniqueSuffix()}@test.invalid`,
      name: "Handoff Coach",
      role: opts?.role ?? "coach",
      deletedAt: opts?.deleted ? new Date() : null,
    })
    .returning({ id: users.id });
  createdUserIds.push(row.id);
  return row;
}

// Offset from "now" so we can place blocks in the past (for no-show) or
// future. hour arg is UTC.
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

async function blockCoachIds(blockId: string): Promise<string[]> {
  const rows = await db
    .select({ coachId: programScheduleBlockCoaches.coachId })
    .from(programScheduleBlockCoaches)
    .where(eq(programScheduleBlockCoaches.blockId, blockId));
  return rows.map((r) => r.coachId).sort();
}

async function primaryCoachId(blockId: string): Promise<string | null> {
  const [row] = await db
    .select({ scheduledCoachId: programScheduleBlocks.scheduledCoachId })
    .from(programScheduleBlocks)
    .where(eq(programScheduleBlocks.id, blockId));
  return row?.scheduledCoachId ?? null;
}

async function insertPostedLog(
  coachId: string,
  programId: string,
  startAt: Date,
  endAt: Date,
): Promise<void> {
  const [row] = await db
    .insert(hourLogs)
    .values({ coachId, programId, startAt, endAt, status: "posted", createdBy: coachId })
    .returning({ id: hourLogs.id });
  createdHourLogIds.push(row.id);
}

// A synthetic coach actor shaped like AuthedSession["user"] (the internal
// fns only read actor.id; cast covers the unused User fields).
function actorFor(id: string): AuthedSession["user"] {
  return {
    id,
    role: "coach",
    scheduleAdmin: false,
  } as AuthedSession["user"];
}

describe("reassignOwnBlockInternal (hand-off)", () => {
  it("moves the block to the recipient, removes the giver, repoints primary, audits", async () => {
    const program = await createProgram();
    const giver = await createCoach();
    const recipient = await createCoach();
    const block = await createBlock({
      programId: program.id,
      coachIds: [giver.id],
      startAt: daysFromNowAt(1, 10),
      endAt: daysFromNowAt(1, 11),
    });
    expect(block.scheduledCoachId).toBe(giver.id);

    const result = await reassignOwnBlockInternal(actorFor(giver.id), {
      blockId: block.id,
      toCoachId: recipient.id,
    });
    expect(result).toEqual({ blockId: block.id, toCoachId: recipient.id });

    expect(await blockCoachIds(block.id)).toEqual([recipient.id].sort());
    expect(await primaryCoachId(block.id)).toBe(recipient.id);

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "program_schedule_block"),
          eq(auditLog.entityId, block.id),
          eq(auditLog.action, "update"),
        ),
      );
    expect(audit).toBeDefined();
    expect(audit.actorUserId).toBe(giver.id);
    const diff = audit.diff as {
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    };
    expect(diff.before.handoffFromCoachId).toBe(giver.id);
    expect(diff.after.handoffToCoachId).toBe(recipient.id);
    expect(diff.after.scheduledCoachId).toBe(recipient.id);
  });

  it("on a multi-coach block, removes only the giver and keeps the primary when the giver wasn't primary", async () => {
    const program = await createProgram();
    const primary = await createCoach();
    const giver = await createCoach();
    const recipient = await createCoach();
    // primary is scheduledCoachIds[0]; giver is a secondary member.
    const block = await createBlock({
      programId: program.id,
      coachIds: [primary.id, giver.id],
      startAt: daysFromNowAt(1, 10),
      endAt: daysFromNowAt(1, 11),
    });
    expect(block.scheduledCoachId).toBe(primary.id);

    await reassignOwnBlockInternal(actorFor(giver.id), {
      blockId: block.id,
      toCoachId: recipient.id,
    });

    expect(await blockCoachIds(block.id)).toEqual(
      [primary.id, recipient.id].sort(),
    );
    // Primary unchanged because the giver wasn't the primary.
    expect(await primaryCoachId(block.id)).toBe(primary.id);
  });

  it("after hand-off, an unlogged past block becomes the RECIPIENT's no-show, not the giver's", async () => {
    const program = await createProgram();
    const giver = await createCoach();
    const recipient = await createCoach();
    // Block 2 days ago → past the 8 AM-next-day no-show threshold.
    const block = await createBlock({
      programId: program.id,
      coachIds: [giver.id],
      startAt: daysFromNowAt(-2, 10),
      endAt: daysFromNowAt(-2, 11),
    });

    await reassignOwnBlockInternal(actorFor(giver.id), {
      blockId: block.id,
      toCoachId: recipient.id,
    });

    const { noShow } = await fetchBlockAccountabilityAlerts(new Date());
    const forBlock = noShow.filter((n) => n.blockId === block.id);
    expect(forBlock).toHaveLength(1);
    expect(forBlock[0].coachId).toBe(recipient.id);
    expect(noShow.some((n) => n.blockId === block.id && n.coachId === giver.id)).toBe(
      false,
    );
  });

  it("rejects handing off to yourself (InvalidHandoffTargetError)", async () => {
    const program = await createProgram();
    const giver = await createCoach();
    const block = await createBlock({
      programId: program.id,
      coachIds: [giver.id],
      startAt: daysFromNowAt(1, 10),
      endAt: daysFromNowAt(1, 11),
    });
    await expect(
      reassignOwnBlockInternal(actorFor(giver.id), {
        blockId: block.id,
        toCoachId: giver.id,
      }),
    ).rejects.toBeInstanceOf(InvalidHandoffTargetError);
  });

  it("rejects a recipient who is soft-deleted or an admin (InvalidHandoffTargetError)", async () => {
    const program = await createProgram();
    const giver = await createCoach();
    const deleted = await createCoach({ deleted: true });
    const admin = await createCoach({ role: "admin" });
    const block = await createBlock({
      programId: program.id,
      coachIds: [giver.id],
      startAt: daysFromNowAt(1, 10),
      endAt: daysFromNowAt(1, 11),
    });
    await expect(
      reassignOwnBlockInternal(actorFor(giver.id), {
        blockId: block.id,
        toCoachId: deleted.id,
      }),
    ).rejects.toBeInstanceOf(InvalidHandoffTargetError);
    await expect(
      reassignOwnBlockInternal(actorFor(giver.id), {
        blockId: block.id,
        toCoachId: admin.id,
      }),
    ).rejects.toBeInstanceOf(InvalidHandoffTargetError);
  });

  it("rejects when the actor isn't a member of the block (NotAssignedToBlockError)", async () => {
    const program = await createProgram();
    const member = await createCoach();
    const outsider = await createCoach();
    const recipient = await createCoach();
    const block = await createBlock({
      programId: program.id,
      coachIds: [member.id],
      startAt: daysFromNowAt(1, 10),
      endAt: daysFromNowAt(1, 11),
    });
    await expect(
      reassignOwnBlockInternal(actorFor(outsider.id), {
        blockId: block.id,
        toCoachId: recipient.id,
      }),
    ).rejects.toBeInstanceOf(NotAssignedToBlockError);
  });

  it("rejects a non-existent block (ProgramScheduleBlockNotFoundError)", async () => {
    const giver = await createCoach();
    const recipient = await createCoach();
    await expect(
      reassignOwnBlockInternal(actorFor(giver.id), {
        blockId: "00000000-0000-0000-0000-000000000000",
        toCoachId: recipient.id,
      }),
    ).rejects.toBeInstanceOf(ProgramScheduleBlockNotFoundError);
  });

  it("rejects when the actor already logged the block (BlockAlreadyLoggedError)", async () => {
    const program = await createProgram();
    const giver = await createCoach();
    const recipient = await createCoach();
    const startAt = daysFromNowAt(-1, 10);
    const endAt = daysFromNowAt(-1, 11);
    const block = await createBlock({
      programId: program.id,
      coachIds: [giver.id],
      startAt,
      endAt,
    });
    await insertPostedLog(giver.id, program.id, startAt, endAt);
    await expect(
      reassignOwnBlockInternal(actorFor(giver.id), {
        blockId: block.id,
        toCoachId: recipient.id,
      }),
    ).rejects.toBeInstanceOf(BlockAlreadyLoggedError);
  });
});

describe("cancelOwnBlockInternal (no cover)", () => {
  it("inserts a 'cancelled' flag (idempotent), audits, and surfaces in the admin review queue", async () => {
    const program = await createProgram();
    const coach = await createCoach();
    const block = await createBlock({
      programId: program.id,
      coachIds: [coach.id],
      startAt: daysFromNowAt(-1, 10),
      endAt: daysFromNowAt(-1, 11),
    });

    await cancelOwnBlockInternal(actorFor(coach.id), {
      blockId: block.id,
      note: "  was sick  ",
    });

    const flags = await db
      .select()
      .from(programBlockCoachFlags)
      .where(
        and(
          eq(programBlockCoachFlags.blockId, block.id),
          eq(programBlockCoachFlags.coachId, coach.id),
        ),
      );
    expect(flags).toHaveLength(1);
    expect(flags[0].kind).toBe("cancelled");
    expect(flags[0].note).toBe("was sick"); // trimmed
    expect(flags[0].createdBy).toBe(coach.id);
    expect(flags[0].reviewedAt).toBeNull();

    // Idempotent — a second call doesn't create a duplicate.
    await cancelOwnBlockInternal(actorFor(coach.id), { blockId: block.id });
    const flags2 = await db
      .select()
      .from(programBlockCoachFlags)
      .where(
        and(
          eq(programBlockCoachFlags.blockId, block.id),
          eq(programBlockCoachFlags.coachId, coach.id),
        ),
      );
    expect(flags2).toHaveLength(1);

    // Audit row for the create.
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityType, "program_block_coach_flag"));
    expect(audits.length).toBeGreaterThanOrEqual(1);

    // Surfaces in the admin needs-review queue as a 'cancelled' alert.
    const { cancelled } = await fetchBlockAccountabilityAlerts(new Date());
    expect(
      cancelled.some((c) => c.flagId === flags[0].id && c.note === "was sick"),
    ).toBe(true);
  });

  it("empty/whitespace note is stored as null", async () => {
    const program = await createProgram();
    const coach = await createCoach();
    const block = await createBlock({
      programId: program.id,
      coachIds: [coach.id],
      startAt: daysFromNowAt(-1, 10),
      endAt: daysFromNowAt(-1, 11),
    });
    await cancelOwnBlockInternal(actorFor(coach.id), {
      blockId: block.id,
      note: "   ",
    });
    const [flag] = await db
      .select()
      .from(programBlockCoachFlags)
      .where(eq(programBlockCoachFlags.blockId, block.id));
    expect(flag.note).toBeNull();
  });

  it("rejects when the actor isn't a member (NotAssignedToBlockError)", async () => {
    const program = await createProgram();
    const member = await createCoach();
    const outsider = await createCoach();
    const block = await createBlock({
      programId: program.id,
      coachIds: [member.id],
      startAt: daysFromNowAt(-1, 10),
      endAt: daysFromNowAt(-1, 11),
    });
    await expect(
      cancelOwnBlockInternal(actorFor(outsider.id), { blockId: block.id }),
    ).rejects.toBeInstanceOf(NotAssignedToBlockError);
  });

  it("rejects when the actor already logged the block (BlockAlreadyLoggedError)", async () => {
    const program = await createProgram();
    const coach = await createCoach();
    const startAt = daysFromNowAt(-1, 10);
    const endAt = daysFromNowAt(-1, 11);
    const block = await createBlock({
      programId: program.id,
      coachIds: [coach.id],
      startAt,
      endAt,
    });
    await insertPostedLog(coach.id, program.id, startAt, endAt);
    await expect(
      cancelOwnBlockInternal(actorFor(coach.id), { blockId: block.id }),
    ).rejects.toBeInstanceOf(BlockAlreadyLoggedError);
  });
});
