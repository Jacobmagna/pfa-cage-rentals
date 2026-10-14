// Integration tests for the PRICE OF A RENTAL WHEN IT IS MOVED (weight room
// build plan, decision W6), against the real dev database.
//
// The rule: `updateSessionInternal` looks the rate up again only when the
// COACH changes or the resource TYPE changes (cage / bullpen / weight room).
// Moving a rental to another spot of the SAME kind (Weight Room 1 -> 2, Cage 1
// -> 2) keeps the rate stored on the row. A move is not a renegotiation: an
// old rental billed at a coach's old rate must not be re-priced at today's
// rate because someone dragged it one column over.
//
// How this file is built:
//   - Every rental is seeded with a direct INSERT at a DISTINCTIVE stored rate
//     (350 per half hour), so "kept" can never coincide with "looked up again".
//   - The re-price path is always given ammunition: the coach has a custom rate
//     for every resource type (weight room 900, cage 1700, bullpen 1900, group
//     weight room 1800), and the second coach has different ones. None of those
//     is 350, and none is the test database's weight room default (700), so
//     no assertion here holds by coincidence with `rate_defaults` (which is NOT
//     truncated between tests and is never touched here).
//   - Assertions are made on what the write RETURNED where the call returns the
//     row. The form action returns only `{ ok: true }`, so its row is read back
//     with a short retry (the Neon HTTP driver can miss a fresh write).
//
// `@/auth` and `next/cache` are mocked at file scope (vi.mock is hoisted), the
// same way weight-room-minimum.test.ts does it.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { coachRateOverrides, resources, sessionsBilling } from "@/db/schema";
import { updateSessionInternal } from "@/lib/server/session-actions";
import { formatPfaDate, formatPfaTime, parsePfaInput } from "@/lib/timezone";
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

// The form actions call revalidatePath() after a successful write. Outside a
// Next.js request that throws, which would hide the success being asserted.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

type Row = typeof sessionsBilling.$inferSelect;
type Resource = typeof resources.$inferSelect;

// The stored rate every rental is seeded with. Matches no configured rate.
const STORED = 350;

// The first coach's custom rates (fixtures.coach).
const COACH_WEIGHT_ROOM = 900;
const COACH_GROUP_WEIGHT_ROOM = 1800;
const COACH_CAGE = 1700;
const COACH_BULLPEN = 1900;

// The second coach's custom rates (fixtures.flaggedCoach).
const OTHER_COACH_WEIGHT_ROOM = 1100;
const OTHER_COACH_CAGE = 1300;

let fixtures: FixtureUsers;
let seeded: Awaited<ReturnType<typeof getSeededResources>>;
// "Bullpen 2" is in the standard seed (seed-resources.ts) but not exposed by
// getSeededResources, so it is looked up here. Undefined if this branch was
// seeded without it; the one test that needs it says so and skips.
let bullpen2: Resource | undefined;

beforeAll(async () => {
  fixtures = await ensureFixtureUsers();
  seeded = await getSeededResources();
  const all = await db.select().from(resources);
  bullpen2 = all.find((r) => r.name === "Bullpen 2" && r.type === "bullpen");
});

beforeEach(async () => {
  // Wipes sessions_billing, audit_log and coach_rate_overrides (NOT
  // rate_defaults), then gives both coaches their custom rates.
  await truncateMutables();
  authMock.mockReset();
  await db.insert(coachRateOverrides).values([
    {
      coachId: fixtures.coach.id,
      resourceType: "weight_room",
      ratePer30MinCents: COACH_WEIGHT_ROOM,
      groupRatePer30MinCents: COACH_GROUP_WEIGHT_ROOM,
    },
    {
      coachId: fixtures.coach.id,
      resourceType: "cage",
      ratePer30MinCents: COACH_CAGE,
    },
    {
      coachId: fixtures.coach.id,
      resourceType: "bullpen",
      ratePer30MinCents: COACH_BULLPEN,
    },
    {
      coachId: fixtures.flaggedCoach.id,
      resourceType: "weight_room",
      ratePer30MinCents: OTHER_COACH_WEIGHT_ROOM,
    },
    {
      coachId: fixtures.flaggedCoach.id,
      resourceType: "cage",
      ratePer30MinCents: OTHER_COACH_CAGE,
    },
  ]);
});

// ── helpers ──────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
// Three PFA days out: clearly future whatever hour the suite runs at.
const FUTURE_DAY = formatPfaDate(new Date(Date.now() + 3 * DAY_MS));

function at(time: string): Date {
  return parsePfaInput(FUTURE_DAY, time);
}

// An OLD rental, the way one sits in the table: written straight in, at the
// distinctive stored rate. 15:00-16:00 unless told otherwise, so a weight room
// rental is always a full hour (the one-hour minimum would refuse a move of a
// shorter one, which is not what this file is about).
async function seedRental(opts: {
  resourceId: string;
  start?: string;
  end?: string;
  isGroupSession?: boolean;
}): Promise<Row> {
  const [row] = await db
    .insert(sessionsBilling)
    .values({
      coachId: fixtures.coach.id,
      resourceId: opts.resourceId,
      startAt: at(opts.start ?? "15:00"),
      endAt: at(opts.end ?? "16:00"),
      ratePer30MinCents: STORED,
      isGroupSession: opts.isGroupSession ?? false,
      createdBy: fixtures.admin.id,
    })
    .returning();
  expect(row.ratePer30MinCents).toBe(STORED);
  return row;
}

async function move(row: Row, resourceId: string): Promise<Row> {
  return updateSessionInternal(fixtures.admin, row.id, { resourceId });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readRowUntil(
  id: string,
  shows: (row: Row) => boolean,
): Promise<Row> {
  let last: Row | undefined;
  for (let attempt = 0; attempt < 8; attempt++) {
    [last] = await db
      .select()
      .from(sessionsBilling)
      .where(eq(sessionsBilling.id, id))
      .limit(1);
    if (last && shows(last)) return last;
    await sleep(250);
  }
  if (!last) throw new Error(`readRowUntil: rental ${id} not found`);
  return last;
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

// What the admin edit dialog sends: every field, always, with only the
// resource changed.
function adminEditForm(row: Row, resourceId: string): FormData {
  const fd = new FormData();
  fd.set("id", row.id);
  fd.set("coachId", row.coachId);
  fd.set("resourceId", resourceId);
  fd.set("date", formatPfaDate(row.startAt));
  fd.set("startTime", formatPfaTime(row.startAt));
  fd.set("endTime", formatPfaTime(row.endAt));
  fd.set("note", row.note ?? "");
  return fd;
}

// ── a move to another spot of the SAME kind keeps the stored rate ────────

describe("updateSessionInternal: a move to another spot of the same kind keeps the stored rate", () => {
  it("a 60-minute weight room rental moved Weight Room 1 -> Weight Room 2 keeps its rate", async () => {
    const old = await seedRental({ resourceId: seeded.weightRoom1.id });

    const updated = await move(old, seeded.weightRoom2.id);

    expect(updated.resourceId).toBe(seeded.weightRoom2.id);
    expect(updated.ratePer30MinCents).toBe(STORED);
    expect(updated.isGroupSession).toBe(false);
  });

  it("a cage rental moved Cage 1 -> Cage 2 keeps its rate", async () => {
    const old = await seedRental({ resourceId: seeded.cage1.id });

    const updated = await move(old, seeded.cage2.id);

    expect(updated.resourceId).toBe(seeded.cage2.id);
    expect(updated.ratePer30MinCents).toBe(STORED);
  });

  it("a bullpen rental moved Bullpen 1 -> Bullpen 2 keeps its rate", async (ctx) => {
    if (!bullpen2) {
      ctx.skip();
      return;
    }
    const old = await seedRental({ resourceId: seeded.bullpen1.id });

    const updated = await move(old, bullpen2.id);

    expect(updated.resourceId).toBe(bullpen2.id);
    expect(updated.ratePer30MinCents).toBe(STORED);
  });

  it("an OLD group weight room rental moved Weight Room 1 -> Weight Room 2 keeps its group flag AND its rate", async () => {
    const old = await seedRental({
      resourceId: seeded.weightRoom1.id,
      isGroupSession: true,
    });

    const updated = await move(old, seeded.weightRoom2.id);

    expect(updated.resourceId).toBe(seeded.weightRoom2.id);
    expect(updated.isGroupSession).toBe(true);
    // Not the coach's group rate (1800), not the regular one (900).
    expect(updated.ratePer30MinCents).toBe(STORED);
  });

  it("through the admin edit form (FormData, every field resent): Weight Room 1 -> Weight Room 2 keeps the rate", async () => {
    mockAsAdmin();
    const { updateSessionFormAction } = await import(
      "@/app/admin/sessions/form-actions"
    );
    const old = await seedRental({ resourceId: seeded.weightRoom1.id });

    const result = await updateSessionFormAction(
      { ok: true },
      adminEditForm(old, seeded.weightRoom2.id),
    );
    expect(result).toEqual({ ok: true });

    const row = await readRowUntil(
      old.id,
      (r) => r.resourceId === seeded.weightRoom2.id,
    );
    expect(row.resourceId).toBe(seeded.weightRoom2.id);
    expect(row.startAt.getTime()).toBe(old.startAt.getTime());
    expect(row.endAt.getTime()).toBe(old.endAt.getTime());
    expect(row.ratePer30MinCents).toBe(STORED);
  });

  it("through the admin edit form (FormData, every field resent): Cage 1 -> Cage 2 keeps the rate", async () => {
    mockAsAdmin();
    const { updateSessionFormAction } = await import(
      "@/app/admin/sessions/form-actions"
    );
    const old = await seedRental({ resourceId: seeded.cage1.id });

    const result = await updateSessionFormAction(
      { ok: true },
      adminEditForm(old, seeded.cage2.id),
    );
    expect(result).toEqual({ ok: true });

    const row = await readRowUntil(
      old.id,
      (r) => r.resourceId === seeded.cage2.id,
    );
    expect(row.resourceId).toBe(seeded.cage2.id);
    expect(row.ratePer30MinCents).toBe(STORED);
  });
});

// ── a change of TYPE or of COACH still re-prices (unchanged behavior) ────

describe("updateSessionInternal: a change of resource type or of coach looks the rate up again", () => {
  it("a 60-minute cage rental moved to a weight room is re-priced at the weight room rate", async () => {
    const old = await seedRental({ resourceId: seeded.cage1.id });

    const updated = await move(old, seeded.weightRoom1.id);

    expect(updated.resourceId).toBe(seeded.weightRoom1.id);
    expect(updated.ratePer30MinCents).toBe(COACH_WEIGHT_ROOM);
  });

  it("a weight room rental moved to a cage is re-priced at the cage rate", async () => {
    const old = await seedRental({ resourceId: seeded.weightRoom1.id });

    const updated = await move(old, seeded.cage1.id);

    expect(updated.resourceId).toBe(seeded.cage1.id);
    expect(updated.ratePer30MinCents).toBe(COACH_CAGE);
  });

  it("an OLD group weight room rental moved to a cage loses the group flag and is re-priced at the cage rate", async () => {
    const old = await seedRental({
      resourceId: seeded.weightRoom1.id,
      isGroupSession: true,
    });

    const updated = await move(old, seeded.cage1.id);

    expect(updated.resourceId).toBe(seeded.cage1.id);
    expect(updated.isGroupSession).toBe(false);
    expect(updated.ratePer30MinCents).toBe(COACH_CAGE);
  });

  it("a coach change on the same spot is re-priced at the NEW coach's rate", async () => {
    const old = await seedRental({ resourceId: seeded.weightRoom1.id });

    const updated = await updateSessionInternal(fixtures.admin, old.id, {
      coachId: fixtures.flaggedCoach.id,
    });

    expect(updated.coachId).toBe(fixtures.flaggedCoach.id);
    expect(updated.resourceId).toBe(seeded.weightRoom1.id);
    expect(updated.ratePer30MinCents).toBe(OTHER_COACH_WEIGHT_ROOM);
  });

  it("a coach change AND a same-kind move together is re-priced at the new coach's rate (the coach change wins)", async () => {
    const old = await seedRental({ resourceId: seeded.weightRoom1.id });

    const updated = await updateSessionInternal(fixtures.admin, old.id, {
      coachId: fixtures.flaggedCoach.id,
      resourceId: seeded.weightRoom2.id,
    });

    expect(updated.coachId).toBe(fixtures.flaggedCoach.id);
    expect(updated.resourceId).toBe(seeded.weightRoom2.id);
    expect(updated.ratePer30MinCents).toBe(OTHER_COACH_WEIGHT_ROOM);
  });

  it("a coach change AND a Cage 1 -> Cage 2 move together is re-priced at the new coach's cage rate", async () => {
    const old = await seedRental({ resourceId: seeded.cage1.id });

    const updated = await updateSessionInternal(fixtures.admin, old.id, {
      coachId: fixtures.flaggedCoach.id,
      resourceId: seeded.cage2.id,
    });

    expect(updated.coachId).toBe(fixtures.flaggedCoach.id);
    expect(updated.ratePer30MinCents).toBe(OTHER_COACH_CAGE);
  });
});

// ── a time-only edit keeps the stored rate (unchanged behavior) ──────────

describe("updateSessionInternal: a time-only edit keeps the stored rate", () => {
  it("lengthening a weight room rental on the same spot keeps its rate", async () => {
    const old = await seedRental({ resourceId: seeded.weightRoom1.id });

    const updated = await updateSessionInternal(fixtures.admin, old.id, {
      endAt: at("16:30"),
    });

    expect(updated.endAt.getTime()).toBe(at("16:30").getTime());
    expect(updated.resourceId).toBe(seeded.weightRoom1.id);
    expect(updated.ratePer30MinCents).toBe(STORED);
  });

  it("re-timing a cage rental on the same spot keeps its rate", async () => {
    const old = await seedRental({ resourceId: seeded.cage1.id });

    const updated = await updateSessionInternal(fixtures.admin, old.id, {
      startAt: at("17:00"),
      endAt: at("18:00"),
    });

    expect(updated.startAt.getTime()).toBe(at("17:00").getTime());
    expect(updated.ratePer30MinCents).toBe(STORED);
  });
});
