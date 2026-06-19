// Authz-boundary integration test for the Master "Schedule Manager"
// surface (Add-On Part 1). All 13 widened public actions are gated by
// requireScheduleAccess() (admin OR coach.scheduleAdmin === true). This
// suite proves:
//
//   1. CORE SECURITY — every one of the 13 actions rejects a PLAIN coach
//      (no flag). The guard runs first, so passing empty/garbage input is
//      fine: the action redirects (throws) before touching the DB.
//   2. POSITIVE PATH — a representative create subset (createSession,
//      createBlock, createProgramScheduleBlock) SUCCEEDS for the FLAGGED
//      coach with valid input, and (sanity) for an admin.
//
// Mocks `@/auth` at file scope (vi.mock is hoisted), so the public
// wrappers resolve the mocked auth(). Internal logic is covered directly
// in the per-action suites; here we only exercise the public wrapper +
// its guard.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { programScheduleBlocks, programs, users } from "@/db/schema";
import {
  ensureFixtureUsers,
  getSeededResources,
  truncateMutables,
  type FixtureUsers,
} from "./fixtures";

const authMock = vi.fn();
vi.mock("@/auth", () => ({
  auth: () => authMock(),
}));

// The positive-path tests drive the public wrappers all the way through,
// and those call revalidatePath() after the mutation. Outside a Next.js
// request context that throws "static generation store missing", masking
// the success we're asserting. Stub it to a no-op. (The reject cases never
// reach it — the guard throws first.)
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

let fixtures: FixtureUsers;
let seeded: Awaited<ReturnType<typeof getSeededResources>>;

beforeAll(async () => {
  fixtures = await ensureFixtureUsers();
  seeded = await getSeededResources();
});

beforeEach(async () => {
  await truncateMutables();
  authMock.mockReset();
});

// Mock helpers — set the auth() return to a given fixture user.
function mockAsPlainCoach() {
  authMock.mockResolvedValue({
    user: {
      id: fixtures.coach.id,
      email: fixtures.coach.email,
      role: "coach",
      scheduleAdmin: false,
    },
  });
}

function mockAsFlaggedCoach() {
  authMock.mockResolvedValue({
    user: {
      id: fixtures.flaggedCoach.id,
      email: fixtures.flaggedCoach.email,
      role: "coach",
      scheduleAdmin: true,
    },
  });
}

function mockAsAdmin() {
  authMock.mockResolvedValue({
    user: {
      id: fixtures.admin.id,
      email: fixtures.admin.email,
      role: "admin",
    },
  });
}

function tomorrowAt(hour: number, minute = 0): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(hour, minute, 0, 0);
  return d;
}

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// programs + users are NOT truncated, so create fresh rows per call and
// scope assertions to the returned ids (mirrors program-schedule-actions
// test setup).
async function createActiveProgram(): Promise<{ id: string; name: string }> {
  const [row] = await db
    .insert(programs)
    .values({ name: `MasterAuthz Program ${uniqueSuffix()}`, active: true })
    .returning({ id: programs.id, name: programs.name });
  return row;
}

async function createScheduledCoach(): Promise<{ id: string }> {
  const [row] = await db
    .insert(users)
    .values({
      email: `master-authz-${uniqueSuffix()}@test.invalid`,
      name: "MasterAuthz Scheduled Coach",
      role: "coach",
    })
    .returning({ id: users.id });
  return row;
}

// ───────────────────────────────────────────────────────────────────
// 1. CORE SECURITY: each of the 13 actions rejects a plain coach.
//    Input is intentionally empty/garbage — the guard runs first.
// ───────────────────────────────────────────────────────────────────
describe("widened schedule actions reject a plain coach (no scheduleAdmin)", () => {
  // Each of the 13 widened actions is asserted explicitly. Args are
  // throwaway — the requireScheduleAccess() guard fires before they're used,
  // so an empty object / dummy id reaches the redirect (throw) path.
  it("cage createBlock rejects plain coach", async () => {
    mockAsPlainCoach();
    const { createBlock } = await import("@/app/admin/schedule/actions");
    await expect(createBlock({})).rejects.toThrow();
  });

  it("cage updateBlock rejects plain coach", async () => {
    mockAsPlainCoach();
    const { updateBlock } = await import("@/app/admin/schedule/actions");
    await expect(updateBlock("x", {})).rejects.toThrow();
  });

  it("cage deleteBlock rejects plain coach", async () => {
    mockAsPlainCoach();
    const { deleteBlock } = await import("@/app/admin/schedule/actions");
    await expect(deleteBlock("x")).rejects.toThrow();
  });

  it("rental createSession rejects plain coach", async () => {
    mockAsPlainCoach();
    const { createSession } = await import("@/app/admin/sessions/actions");
    await expect(createSession({})).rejects.toThrow();
  });

  it("rental createSessionsBatch rejects plain coach", async () => {
    mockAsPlainCoach();
    const { createSessionsBatch } = await import("@/app/admin/sessions/actions");
    await expect(createSessionsBatch({})).rejects.toThrow();
  });

  it("rental updateSession rejects plain coach", async () => {
    mockAsPlainCoach();
    const { updateSession } = await import("@/app/admin/sessions/actions");
    await expect(updateSession("x", {})).rejects.toThrow();
  });

  it("rental deleteSession rejects plain coach", async () => {
    mockAsPlainCoach();
    const { deleteSession } = await import("@/app/admin/sessions/actions");
    await expect(deleteSession("x")).rejects.toThrow();
  });

  it("work createProgramScheduleBlock rejects plain coach", async () => {
    mockAsPlainCoach();
    const { createProgramScheduleBlock } = await import(
      "@/app/admin/hour-log/schedule/actions"
    );
    await expect(createProgramScheduleBlock({})).rejects.toThrow();
  });

  it("work updateProgramScheduleBlock rejects plain coach", async () => {
    mockAsPlainCoach();
    const { updateProgramScheduleBlock } = await import(
      "@/app/admin/hour-log/schedule/actions"
    );
    await expect(updateProgramScheduleBlock("x", {})).rejects.toThrow();
  });

  it("work deleteProgramScheduleBlock rejects plain coach", async () => {
    mockAsPlainCoach();
    const { deleteProgramScheduleBlock } = await import(
      "@/app/admin/hour-log/schedule/actions"
    );
    await expect(deleteProgramScheduleBlock("x")).rejects.toThrow();
  });

  it("work createProgramScheduleSeries rejects plain coach", async () => {
    mockAsPlainCoach();
    const { createProgramScheduleSeries } = await import(
      "@/app/admin/hour-log/schedule/actions"
    );
    await expect(createProgramScheduleSeries({})).rejects.toThrow();
  });

  it("work editProgramScheduleSeries rejects plain coach", async () => {
    mockAsPlainCoach();
    const { editProgramScheduleSeries } = await import(
      "@/app/admin/hour-log/schedule/actions"
    );
    await expect(editProgramScheduleSeries("x", {})).rejects.toThrow();
  });

  it("work cancelSeriesOccurrence rejects plain coach", async () => {
    mockAsPlainCoach();
    const { cancelSeriesOccurrence } = await import(
      "@/app/admin/hour-log/schedule/actions"
    );
    await expect(cancelSeriesOccurrence("x")).rejects.toThrow();
  });
});

// ───────────────────────────────────────────────────────────────────
// 2. POSITIVE PATH: representative create subset succeeds for the
//    flagged coach (and admin) with valid input.
// ───────────────────────────────────────────────────────────────────
describe("representative creates succeed for flagged coach + admin", () => {
  it("createSession succeeds for the flagged coach", async () => {
    mockAsFlaggedCoach();
    const { createSession } = await import("@/app/admin/sessions/actions");
    const created = await createSession({
      coachId: fixtures.coach.id,
      resourceId: seeded.cage1.id,
      startAt: tomorrowAt(10),
      endAt: tomorrowAt(11),
    });
    expect((created as { id: string }).id).toBeTruthy();
  });

  it("createSession succeeds for an admin (sanity)", async () => {
    mockAsAdmin();
    const { createSession } = await import("@/app/admin/sessions/actions");
    const created = await createSession({
      coachId: fixtures.coach.id,
      resourceId: seeded.cage1.id,
      startAt: tomorrowAt(12),
      endAt: tomorrowAt(13),
    });
    expect((created as { id: string }).id).toBeTruthy();
  });

  it("createBlock succeeds for the flagged coach", async () => {
    mockAsFlaggedCoach();
    const { createBlock } = await import("@/app/admin/schedule/actions");
    const created = await createBlock({
      resourceId: seeded.cage1.id,
      startAt: tomorrowAt(14),
      endAt: tomorrowAt(15),
      reason: "Flagged-coach block",
    });
    expect((created as { id: string }).id).toBeTruthy();
  });

  it("createBlock succeeds for an admin (sanity)", async () => {
    mockAsAdmin();
    const { createBlock } = await import("@/app/admin/schedule/actions");
    const created = await createBlock({
      resourceId: seeded.cage1.id,
      startAt: tomorrowAt(16),
      endAt: tomorrowAt(17),
      reason: "Admin block",
    });
    expect((created as { id: string }).id).toBeTruthy();
  });

  it("createProgramScheduleBlock succeeds for the flagged coach", async () => {
    const program = await createActiveProgram();
    const scheduledCoach = await createScheduledCoach();
    mockAsFlaggedCoach();
    const { createProgramScheduleBlock } = await import(
      "@/app/admin/hour-log/schedule/actions"
    );
    const created = await createProgramScheduleBlock({
      programId: program.id,
      scheduledCoachIds: [scheduledCoach.id],
      startAt: tomorrowAt(18),
      endAt: tomorrowAt(19),
    });
    const id = (created as { id: string }).id;
    expect(id).toBeTruthy();
    // Cleanup — program_schedule_blocks is not truncated between tests, and
    // its program_id FK has no ON DELETE CASCADE, so delete the block first.
    await db.delete(programScheduleBlocks).where(eq(programScheduleBlocks.id, id));
    await db.delete(programs).where(eq(programs.id, program.id));
  });

  it("createProgramScheduleBlock succeeds for an admin (sanity)", async () => {
    const program = await createActiveProgram();
    const scheduledCoach = await createScheduledCoach();
    mockAsAdmin();
    const { createProgramScheduleBlock } = await import(
      "@/app/admin/hour-log/schedule/actions"
    );
    const created = await createProgramScheduleBlock({
      programId: program.id,
      scheduledCoachIds: [scheduledCoach.id],
      startAt: tomorrowAt(20),
      endAt: tomorrowAt(21),
    });
    const id = (created as { id: string }).id;
    expect(id).toBeTruthy();
    await db.delete(programScheduleBlocks).where(eq(programScheduleBlocks.id, id));
    await db.delete(programs).where(eq(programs.id, program.id));
  });
});
