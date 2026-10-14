// Integration tests for createSessionsBatchAction (src/app/admin/sessions/
// form-actions.ts), the multi-slot create on the two admin dialogs (the
// create dialog's Session tab, and SessionFormDialog in create mode), against
// the real dev database.
//
// What it must do:
//   - A known refusal comes back as a RESULT, `{ ok: false, error: { code,
//     message } }`, carrying the real sentence. (A thrown server-action error
//     reaches the browser with its message stripped on a production build, so
//     the dialogs could only show the framework's sentence.)
//   - ONLY the user-correctable refusals come back as a result: overlap,
//     block, weight room minimum, and the 16-hour span (a typo'd date), that
//     last one as the plain sentence with no "slots.0.endAt:" prefix.
//     Anything else (a resource that is not there, any other ZodError, …) is
//     THROWN, so it reaches Sentry and the dialogs show their fixed fallback.
//   - A clean batch comes back `{ ok: true, count }`, where count is the
//     rentals SAVED (back-to-back weight room slots are one rental).
//   - Authorization is exactly the public createSessionsBatch's, because it
//     calls it: a signed-out caller and a plain coach are refused with the
//     very same redirect createSessionsBatch throws, and nothing is written;
//     an admin and a Schedule Manager are let through.
//
// How this file is built:
//   - EVERY refusal fixture fails for exactly one reason: valid ids, an empty
//     calendar (TRUNCATE before each test), and only the one thing in the way.
//     Each is followed in the same test by a control through the SAME action
//     that goes through, so a refusal can never pass because the action
//     refuses everything.
//   - Dates are three days out so nothing is a past rental.
//
// `@/auth` and `next/cache` are mocked at file scope (vi.mock is hoisted), the
// same way admin-move-session-action.test.ts does it.

import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asc } from "drizzle-orm";
import { ZodError } from "zod";
import { db } from "@/db";
import { sessionsBilling } from "@/db/schema";
import { ResourceNotFoundError } from "@/lib/errors";
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

// createSessionsBatch calls revalidatePath() after a successful write.
// Outside a Next.js request that throws, which would hide the success being
// asserted.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

type Row = typeof sessionsBilling.$inferSelect;

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

// The payload the two dialogs build: one coach, one resource, a slot per
// half hour (from SessionSlotsList), each with its own note.
function batchInput(
  resourceId: string,
  ranges: Array<[string, string]>,
  coachId = fixtures.coach.id,
) {
  return {
    coachId,
    resourceId,
    slots: ranges.map(([start, end]) => ({
      startAt: at(start),
      endAt: at(end),
      note: null,
    })),
  };
}

async function createSessionsBatchAction(input: unknown) {
  const mod = await import("@/app/admin/sessions/form-actions");
  return mod.createSessionsBatchAction(input);
}

async function createSessionsBatch(input: unknown) {
  const mod = await import("@/app/admin/sessions/actions");
  return mod.createSessionsBatch(input);
}

async function allRows(): Promise<Row[]> {
  return db.select().from(sessionsBilling).orderBy(asc(sessionsBilling.startAt));
}

async function seedRival(resourceId: string, start: string, end: string) {
  await db.insert(sessionsBilling).values({
    coachId: fixtures.flaggedCoach.id,
    resourceId,
    startAt: at(start),
    endAt: at(end),
    note: null,
    ratePer30MinCents: 913,
    isGroupSession: false,
    createdBy: fixtures.admin.id,
  });
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

// ── refusals come back as results with the real sentence ─────────────────

describe("createSessionsBatchAction: refusals come back as a result, not a throw", () => {
  it("SESSION_OVERLAP: a cage multi-slot range where one half hour is taken; nothing is written", async () => {
    mockAsAdmin();
    await seedRival(seeded.cage1.id, "15:30", "16:00");

    const refused = await createSessionsBatchAction(
      batchInput(seeded.cage1.id, [
        ["15:00", "15:30"],
        ["15:30", "16:00"],
      ]),
    );
    expect(refused).toEqual({
      ok: false,
      error: {
        code: "SESSION_OVERLAP",
        message: `${seeded.cage1.name} is already booked by ${fixtures.flaggedCoach.name}`,
      },
    });
    // Only the rival's rental: the free 3:00 half hour was not saved either.
    expect(await allRows()).toHaveLength(1);

    // Control: the same action, the same cage, an hour later.
    const saved = await createSessionsBatchAction(
      batchInput(seeded.cage1.id, [
        ["17:00", "17:30"],
        ["17:30", "18:00"],
      ]),
    );
    expect(saved).toEqual({ ok: true, count: 2 });
    expect(await allRows()).toHaveLength(3);
  });

  it("WEIGHT_ROOM_MINIMUM: a lone 30-minute weight room slot; nothing is written", async () => {
    mockAsAdmin();

    const refused = await createSessionsBatchAction(
      batchInput(seeded.weightRoom1.id, [["15:00", "15:30"]]),
    );
    expect(refused).toEqual({
      ok: false,
      error: {
        code: "WEIGHT_ROOM_MINIMUM",
        message: `Weight room rentals are one hour minimum. Book at least 1 hour on ${seeded.weightRoom1.name}.`,
      },
    });
    expect(await allRows()).toHaveLength(0);

    // Control: the same action, the same weight room, two back-to-back halves.
    const saved = await createSessionsBatchAction(
      batchInput(seeded.weightRoom1.id, [
        ["15:00", "15:30"],
        ["15:30", "16:00"],
      ]),
    );
    expect(saved).toEqual({ ok: true, count: 1 });
  });
});

// ── the 16-hour span comes back as its plain sentence ────────────────────

describe("createSessionsBatchAction: a span over 16 hours comes back as the plain sentence", () => {
  it("one slot over 16 hours: { ok: false } with the sentence and no path; nothing is written", async () => {
    mockAsAdmin();
    const start = at("06:00");

    const refused = await createSessionsBatchAction({
      coachId: fixtures.coach.id,
      resourceId: seeded.cage1.id,
      slots: [
        {
          startAt: start,
          endAt: new Date(start.getTime() + 17 * 3_600_000),
          note: null,
        },
      ],
    });
    expect(refused).toEqual({
      ok: false,
      error: { code: "VALIDATION", message: MAX_DURATION_MESSAGE },
    });
    expect(await allRows()).toHaveLength(0);

    // Control: the same action, the same cage, a normal length.
    const saved = await createSessionsBatchAction(
      batchInput(seeded.cage1.id, [["15:00", "15:30"]]),
    );
    expect(saved).toEqual({ ok: true, count: 1 });
  });

  it("two back-to-back 16-hour weight room slots (one 32-hour rental once joined): the same sentence; nothing is written", async () => {
    mockAsAdmin();
    const start = at("00:00");
    const mid = new Date(start.getTime() + 16 * 3_600_000);
    const end = new Date(start.getTime() + 32 * 3_600_000);

    const refused = await createSessionsBatchAction({
      coachId: fixtures.coach.id,
      resourceId: seeded.weightRoom1.id,
      slots: [
        { startAt: start, endAt: mid, note: null },
        { startAt: mid, endAt: end, note: null },
      ],
    });
    expect(refused).toEqual({
      ok: false,
      error: { code: "VALIDATION", message: MAX_DURATION_MESSAGE },
    });
    expect(await allRows()).toHaveLength(0);

    // Control: two back-to-back half hours on the same weight room.
    const saved = await createSessionsBatchAction(
      batchInput(seeded.weightRoom1.id, [
        ["15:00", "15:30"],
        ["15:30", "16:00"],
      ]),
    );
    expect(saved).toEqual({ ok: true, count: 1 });
  });
});

// ── anything else is thrown, not returned ────────────────────────────────

describe("createSessionsBatchAction: anything that is not a user-correctable refusal is thrown", () => {
  it("a resource id that does not exist: throws ResourceNotFoundError; nothing is written", async () => {
    mockAsAdmin();

    const err = await thrown(() =>
      createSessionsBatchAction(
        batchInput(randomUUID(), [
          ["15:00", "15:30"],
          ["15:30", "16:00"],
        ]),
      ),
    );
    expect(err).toBeInstanceOf(ResourceNotFoundError);
    expect(await allRows()).toHaveLength(0);

    // Control: the same action and slots on a real cage.
    const saved = await createSessionsBatchAction(
      batchInput(seeded.cage1.id, [
        ["15:00", "15:30"],
        ["15:30", "16:00"],
      ]),
    );
    expect(saved).toEqual({ ok: true, count: 2 });
  });

  it("any other ZodError (here an empty coach id) is thrown; nothing is written", async () => {
    mockAsAdmin();

    const err = await thrown(() =>
      createSessionsBatchAction(
        batchInput(seeded.cage1.id, [["15:00", "15:30"]], ""),
      ),
    );
    expect(err).toBeInstanceOf(ZodError);
    expect((err as ZodError).issues[0].message).not.toBe(MAX_DURATION_MESSAGE);
    expect(await allRows()).toHaveLength(0);

    // Control: the same action and slot with the coach filled in.
    const saved = await createSessionsBatchAction(
      batchInput(seeded.cage1.id, [["15:00", "15:30"]]),
    );
    expect(saved).toEqual({ ok: true, count: 1 });
  });
});

// ── clean batches: count is rentals saved ────────────────────────────────

describe("createSessionsBatchAction: a clean batch", () => {
  it("two cage half hours: { ok: true, count: 2 }, two rows", async () => {
    mockAsAdmin();
    const result = await createSessionsBatchAction(
      batchInput(seeded.cage1.id, [
        ["15:00", "15:30"],
        ["15:30", "16:00"],
      ]),
    );
    expect(result).toEqual({ ok: true, count: 2 });

    const rows = await allRows();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.resourceId).toBe(seeded.cage1.id);
      expect(row.coachId).toBe(fixtures.coach.id);
      expect(row.endAt.getTime() - row.startAt.getTime()).toBe(30 * 60_000);
    }
  });

  it("a back-to-back weight room pair: { ok: true, count: 1 }, one one-hour row", async () => {
    mockAsAdmin();
    const result = await createSessionsBatchAction(
      batchInput(seeded.weightRoom1.id, [
        ["15:00", "15:30"],
        ["15:30", "16:00"],
      ]),
    );
    expect(result).toEqual({ ok: true, count: 1 });

    const rows = await allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].resourceId).toBe(seeded.weightRoom1.id);
    expect(rows[0].startAt.getTime()).toBe(at("15:00").getTime());
    expect(rows[0].endAt.getTime()).toBe(at("16:00").getTime());
  });
});

// ── authorization: exactly createSessionsBatch's ─────────────────────────

describe("createSessionsBatchAction: authorization is exactly createSessionsBatch's", () => {
  it("signed out: refused with the same redirect createSessionsBatch throws; nothing is written", async () => {
    const input = batchInput(seeded.cage1.id, [
      ["15:00", "15:30"],
      ["15:30", "16:00"],
    ]);

    mockSignedOut();
    const fromAction = await thrown(() => createSessionsBatchAction(input));
    const fromPublic = await thrown(() => createSessionsBatch(input));
    expect(digestOf(fromAction)).toMatch(/^NEXT_REDIRECT;/);
    expect(digestOf(fromAction)).toBe(digestOf(fromPublic));
    expect(await allRows()).toHaveLength(0);

    // Control: the same call as an admin goes through.
    mockAsAdmin();
    expect(await createSessionsBatchAction(input)).toEqual({
      ok: true,
      count: 2,
    });
  });

  it("plain coach (no Schedule Manager flag): refused with the same redirect createSessionsBatch throws; nothing is written", async () => {
    const input = batchInput(seeded.cage1.id, [
      ["15:00", "15:30"],
      ["15:30", "16:00"],
    ]);

    mockAsCoach();
    const fromAction = await thrown(() => createSessionsBatchAction(input));
    const fromPublic = await thrown(() => createSessionsBatch(input));
    expect(digestOf(fromAction)).toMatch(/^NEXT_REDIRECT;/);
    expect(digestOf(fromAction)).toContain("/coach");
    expect(digestOf(fromAction)).toBe(digestOf(fromPublic));
    expect(await allRows()).toHaveLength(0);

    // Control: the same call as an admin goes through.
    mockAsAdmin();
    expect(await createSessionsBatchAction(input)).toEqual({
      ok: true,
      count: 2,
    });
  });

  it("Schedule Manager (coach with scheduleAdmin): allowed, as createSessionsBatch allows", async () => {
    mockAsScheduleManager();
    const result = await createSessionsBatchAction(
      batchInput(seeded.cage2.id, [
        ["15:00", "15:30"],
        ["15:30", "16:00"],
      ]),
    );
    expect(result).toEqual({ ok: true, count: 2 });
    expect(await allRows()).toHaveLength(2);
  });
});
