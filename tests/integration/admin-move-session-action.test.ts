// Integration tests for moveSessionAction (src/app/admin/sessions/form-actions.ts),
// the drag-and-drop move on the two admin grids, against the real dev
// database.
//
// What it must do:
//   - A known refusal comes back as a RESULT, `{ ok: false, error: { code,
//     message } }`, carrying the real sentence. (A thrown server-action error
//     reaches the browser with its message stripped on a production build.)
//   - A clean move comes back `{ ok: true }` and the row really moved.
//   - ONLY the user-correctable refusals (overlap, block, weight room
//     minimum) come back as a result. Anything else (a rental that is not
//     there, a span over 16 hours, …) is THROWN, so it reaches Sentry and the
//     grid shows its own fixed fallback sentence, never raw internal text.
//   - Authorization is exactly the public updateSession's, because it calls
//     it: a signed-out caller and a plain coach are refused with the very
//     same redirect updateSession throws, and nothing is written; an admin and
//     a Schedule Manager (coach with scheduleAdmin) are let through.
//
// How this file is built:
//   - EVERY refusal fixture fails for exactly one reason: valid ids, an empty
//     calendar (TRUNCATE before each test), and only the one thing in the way
//     (one rival rental, OR one block, OR a weight room target). Each is
//     followed in the same test by a control through the SAME action that
//     goes through, so a refusal can never pass because the action refuses
//     everything.
//   - Rentals are seeded with a direct INSERT on cages. Dates are three days
//     out so nothing is a past rental.
//
// `@/auth` and `next/cache` are mocked at file scope (vi.mock is hoisted), the
// same way weight-room-minimum.test.ts does it.

import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { ZodError } from "zod";
import { db } from "@/db";
import { blockedTimes, sessionsBilling } from "@/db/schema";
import { SessionNotFoundError } from "@/lib/errors";
import { MAX_DURATION_MESSAGE } from "@/lib/schemas/session";
import { formatPfaDate, parsePfaInput } from "@/lib/timezone";
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

// updateSession calls revalidatePath() after a successful write. Outside a
// Next.js request that throws, which would hide the success being asserted.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

type Row = typeof sessionsBilling.$inferSelect;

const WEIGHT_ROOM_UPDATE_MESSAGE =
  "Weight room rentals are one hour minimum. To change the time or spot, make this rental at least 1 hour.";

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

// ── helpers ──────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const FUTURE_DAY = formatPfaDate(new Date(Date.now() + 3 * DAY_MS));

function at(time: string): Date {
  return parsePfaInput(FUTURE_DAY, time);
}

function mockAsAdmin() {
  authMock.mockResolvedValue({
    user: {
      id: fixtures.admin.id,
      email: fixtures.admin.email,
      name: fixtures.admin.name,
      role: "admin",
    },
  });
}

function mockAsCoach() {
  authMock.mockResolvedValue({
    user: {
      id: fixtures.coach.id,
      email: fixtures.coach.email,
      name: fixtures.coach.name,
      role: "coach",
      scheduleAdmin: false,
    },
  });
}

function mockAsScheduleManager() {
  authMock.mockResolvedValue({
    user: {
      id: fixtures.flaggedCoach.id,
      email: fixtures.flaggedCoach.email,
      name: fixtures.flaggedCoach.name,
      role: "coach",
      scheduleAdmin: true,
    },
  });
}

function mockSignedOut() {
  authMock.mockResolvedValue(null);
}

async function seedRental(opts: {
  resourceId: string;
  start: string;
  end: string;
  coachId?: string;
}): Promise<Row> {
  const [row] = await db
    .insert(sessionsBilling)
    .values({
      coachId: opts.coachId ?? fixtures.coach.id,
      resourceId: opts.resourceId,
      startAt: at(opts.start),
      endAt: at(opts.end),
      note: null,
      ratePer30MinCents: 913,
      isGroupSession: false,
      createdBy: fixtures.admin.id,
    })
    .returning();
  return row;
}

async function readRow(id: string): Promise<Row | undefined> {
  const [row] = await db
    .select()
    .from(sessionsBilling)
    .where(eq(sessionsBilling.id, id))
    .limit(1);
  return row;
}

async function moveSessionAction(
  id: string,
  input: { resourceId: string; startAt: Date; endAt: Date },
) {
  const mod = await import("@/app/admin/sessions/form-actions");
  return mod.moveSessionAction(id, input);
}

async function updateSession(
  id: string,
  input: { resourceId: string; startAt: Date; endAt: Date },
) {
  const mod = await import("@/app/admin/sessions/actions");
  return mod.updateSession(id, input);
}

// Runs `fn` and returns what it threw; fails plainly if it did not throw.
async function thrown(fn: () => Promise<unknown>): Promise<unknown> {
  let resolved: unknown;
  try {
    resolved = await fn();
  } catch (err) {
    return err;
  }
  expect.fail(
    `expected a throw, but it resolved with ${JSON.stringify(resolved)}`,
  );
}

function digestOf(err: unknown): string | undefined {
  return (err as { digest?: string } | null)?.digest;
}

function expectUnchanged(after: Row | undefined, before: Row) {
  expect(after).toBeDefined();
  expect(after!.resourceId).toBe(before.resourceId);
  expect(after!.startAt.getTime()).toBe(before.startAt.getTime());
  expect(after!.endAt.getTime()).toBe(before.endAt.getTime());
}

// ── refusals come back as results with the real sentence ─────────────────

describe("moveSessionAction: refusals come back as a result, not a throw", () => {
  it("SESSION_OVERLAP: dropped onto a rental another coach holds", async () => {
    mockAsAdmin();
    const mover = await seedRental({
      resourceId: seeded.cage1.id,
      start: "15:00",
      end: "15:30",
    });
    await seedRental({
      resourceId: seeded.cage2.id,
      start: "15:00",
      end: "15:30",
      coachId: fixtures.flaggedCoach.id,
    });

    const refused = await moveSessionAction(mover.id, {
      resourceId: seeded.cage2.id,
      startAt: at("15:00"),
      endAt: at("15:30"),
    });
    expect(refused).toEqual({
      ok: false,
      error: {
        code: "SESSION_OVERLAP",
        message: `${seeded.cage2.name} is already booked by ${fixtures.flaggedCoach.name}`,
      },
    });
    expectUnchanged(await readRow(mover.id), mover);

    // Control: the same rental, same action, an hour later on the same cage.
    const moved = await moveSessionAction(mover.id, {
      resourceId: seeded.cage2.id,
      startAt: at("16:00"),
      endAt: at("16:30"),
    });
    expect(moved).toEqual({ ok: true });
  });

  it("BLOCKED_TIME: dropped onto blocked time", async () => {
    mockAsAdmin();
    const mover = await seedRental({
      resourceId: seeded.cage1.id,
      start: "15:00",
      end: "15:30",
    });
    await db.insert(blockedTimes).values({
      resourceId: seeded.cage2.id,
      startAt: at("15:00"),
      endAt: at("16:00"),
      reason: "Move test block",
      createdBy: fixtures.admin.id,
    });

    const refused = await moveSessionAction(mover.id, {
      resourceId: seeded.cage2.id,
      startAt: at("15:00"),
      endAt: at("15:30"),
    });
    expect(refused).toEqual({
      ok: false,
      error: {
        code: "BLOCKED_TIME",
        message: `${seeded.cage2.name} is blocked: Move test block`,
      },
    });
    expectUnchanged(await readRow(mover.id), mover);

    // Control: same cage, just after the block ends.
    const moved = await moveSessionAction(mover.id, {
      resourceId: seeded.cage2.id,
      startAt: at("16:00"),
      endAt: at("16:30"),
    });
    expect(moved).toEqual({ ok: true });
  });

  it("WEIGHT_ROOM_MINIMUM: a 30-minute cage rental dropped on a weight room", async () => {
    mockAsAdmin();
    const short = await seedRental({
      resourceId: seeded.cage1.id,
      start: "15:00",
      end: "15:30",
    });

    const refused = await moveSessionAction(short.id, {
      resourceId: seeded.weightRoom1.id,
      startAt: at("15:00"),
      endAt: at("15:30"),
    });
    expect(refused).toEqual({
      ok: false,
      error: {
        code: "WEIGHT_ROOM_MINIMUM",
        message: WEIGHT_ROOM_UPDATE_MESSAGE,
      },
    });
    expectUnchanged(await readRow(short.id), short);

    // Control: a ONE-HOUR cage rental, same action, same empty weight room.
    const hour = await seedRental({
      resourceId: seeded.cage1.id,
      start: "17:00",
      end: "18:00",
    });
    const moved = await moveSessionAction(hour.id, {
      resourceId: seeded.weightRoom1.id,
      startAt: at("17:00"),
      endAt: at("18:00"),
    });
    expect(moved).toEqual({ ok: true });
  });
});

// ── anything else is thrown, not returned ────────────────────────────────

describe("moveSessionAction: anything that is not a user-correctable refusal is thrown", () => {
  it("a rental id that does not exist: throws SessionNotFoundError, and nothing changes", async () => {
    mockAsAdmin();
    const bystander = await seedRental({
      resourceId: seeded.cage1.id,
      start: "15:00",
      end: "15:30",
    });
    const target = {
      resourceId: seeded.cage2.id,
      startAt: at("16:00"),
      endAt: at("16:30"),
    };

    const err = await thrown(() => moveSessionAction(randomUUID(), target));
    expect(err).toBeInstanceOf(SessionNotFoundError);
    expectUnchanged(await readRow(bystander.id), bystander);
    const rows = await db.select().from(sessionsBilling);
    expect(rows).toHaveLength(1);

    // Control: the same action and target, with a real rental id.
    expect(await moveSessionAction(bystander.id, target)).toEqual({ ok: true });
  });

  it("a span over 16 hours: the ZodError is thrown, not returned, and nothing moves", async () => {
    mockAsAdmin();
    const mover = await seedRental({
      resourceId: seeded.cage1.id,
      start: "15:00",
      end: "15:30",
    });
    const start = at("15:00");

    const err = await thrown(() =>
      moveSessionAction(mover.id, {
        resourceId: seeded.cage2.id,
        startAt: start,
        endAt: new Date(start.getTime() + 17 * 3_600_000),
      }),
    );
    expect(err).toBeInstanceOf(ZodError);
    expect((err as ZodError).issues[0].message).toBe(MAX_DURATION_MESSAGE);
    expectUnchanged(await readRow(mover.id), mover);

    // Control: the same rental, same action, a normal length.
    expect(
      await moveSessionAction(mover.id, {
        resourceId: seeded.cage2.id,
        startAt: at("15:00"),
        endAt: at("15:30"),
      }),
    ).toEqual({ ok: true });
  });
});

// ── a clean move ─────────────────────────────────────────────────────────

describe("moveSessionAction: a clean move", () => {
  it("returns { ok: true } and the row is on the new resource at the new time", async () => {
    mockAsAdmin();
    const mover = await seedRental({
      resourceId: seeded.cage1.id,
      start: "15:00",
      end: "15:30",
    });

    const result = await moveSessionAction(mover.id, {
      resourceId: seeded.cage2.id,
      startAt: at("18:30"),
      endAt: at("19:00"),
    });
    expect(result).toEqual({ ok: true });

    const after = await readRow(mover.id);
    expect(after).toBeDefined();
    expect(after!.resourceId).toBe(seeded.cage2.id);
    expect(after!.startAt.getTime()).toBe(at("18:30").getTime());
    expect(after!.endAt.getTime()).toBe(at("19:00").getTime());
    // Only the spot and time change on a drag.
    expect(after!.coachId).toBe(mover.coachId);
    expect(after!.note).toBe(mover.note);
  });

  it("accepts the times as ISO strings too", async () => {
    mockAsAdmin();
    const mover = await seedRental({
      resourceId: seeded.cage1.id,
      start: "15:00",
      end: "15:30",
    });
    const mod = await import("@/app/admin/sessions/form-actions");
    const result = await mod.moveSessionAction(mover.id, {
      resourceId: seeded.cage1.id,
      startAt: at("19:30").toISOString(),
      endAt: at("20:00").toISOString(),
    });
    expect(result).toEqual({ ok: true });
    const after = await readRow(mover.id);
    expect(after!.startAt.getTime()).toBe(at("19:30").getTime());
  });
});

// ── authorization: exactly updateSession's ───────────────────────────────

describe("moveSessionAction: authorization is exactly updateSession's", () => {
  it("signed out: refused with the same redirect updateSession throws; nothing moves", async () => {
    const mover = await seedRental({
      resourceId: seeded.cage1.id,
      start: "15:00",
      end: "15:30",
    });
    const target = {
      resourceId: seeded.cage2.id,
      startAt: at("16:00"),
      endAt: at("16:30"),
    };

    mockSignedOut();
    const fromMove = await thrown(() => moveSessionAction(mover.id, target));
    const fromUpdate = await thrown(() => updateSession(mover.id, target));
    expect(digestOf(fromMove)).toMatch(/^NEXT_REDIRECT;/);
    expect(digestOf(fromMove)).toBe(digestOf(fromUpdate));
    expectUnchanged(await readRow(mover.id), mover);

    // Control: the same call as an admin goes through.
    mockAsAdmin();
    expect(await moveSessionAction(mover.id, target)).toEqual({ ok: true });
  });

  it("plain coach (no Schedule Manager flag): refused with the same redirect updateSession throws; nothing moves", async () => {
    const mover = await seedRental({
      resourceId: seeded.cage1.id,
      start: "15:00",
      end: "15:30",
    });
    const target = {
      resourceId: seeded.cage2.id,
      startAt: at("16:00"),
      endAt: at("16:30"),
    };

    mockAsCoach();
    const fromMove = await thrown(() => moveSessionAction(mover.id, target));
    const fromUpdate = await thrown(() => updateSession(mover.id, target));
    expect(digestOf(fromMove)).toMatch(/^NEXT_REDIRECT;/);
    expect(digestOf(fromMove)).toContain("/coach");
    expect(digestOf(fromMove)).toBe(digestOf(fromUpdate));
    expectUnchanged(await readRow(mover.id), mover);

    // Control: the same call as an admin goes through.
    mockAsAdmin();
    expect(await moveSessionAction(mover.id, target)).toEqual({ ok: true });
  });

  it("Schedule Manager (coach with scheduleAdmin): allowed, as on /master/schedule today", async () => {
    mockAsScheduleManager();
    const mover = await seedRental({
      resourceId: seeded.cage1.id,
      start: "15:00",
      end: "15:30",
    });
    const result = await moveSessionAction(mover.id, {
      resourceId: seeded.cage2.id,
      startAt: at("16:00"),
      endAt: at("16:30"),
    });
    expect(result).toEqual({ ok: true });
    const after = await readRow(mover.id);
    expect(after!.resourceId).toBe(seeded.cage2.id);
    expect(after!.startAt.getTime()).toBe(at("16:00").getTime());
  });
});
