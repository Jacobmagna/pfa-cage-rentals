// Integration tests for src/lib/server/display-schedule.ts — the ONLY query
// behind the unauthenticated facility TV display. Hits the real Neon dev
// branch.
//
// 🔴 THE FIRST DESCRIBE BLOCK IS THE POINT OF THIS FILE. The display page has
// no auth gate, and this repo has no middleware, so the projection in
// display-schedule.ts is the only thing standing between a free-text field an
// admin typed and the public internet. These tests seed UNIQUE SENTINEL
// STRINGS into exactly the fields that must never escape, and assert those
// strings are absent from the serialized result — rather than asserting that
// some property is undefined, which would pass just as happily against a
// result shape that had quietly grown a new column.
//
// Every fixture is dated in 2037, a year no other suite in this repo uses
// (2029 admin-hour-entry, 2031 multi-coach, 2033 approval-sync, 2035 no-show
// horizon) — discipline rule 20, because this module reads across whole
// tables rather than scoping to its own rows.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { blockedTimes, resources, sessionsBilling, users } from "@/db/schema";
import { pfaWallClockToUtc } from "@/lib/timezone";
import { computeDisplayWindow, type DisplayWindow } from "@/lib/display/window";
import {
  DISPLAY_UNNAMED_COACH_LABEL,
  fetchDisplaySchedule,
  fetchDisplayScheduleRows,
} from "@/lib/server/display-schedule";
import {
  ensureFixtureUsers,
  getSeededResources,
  truncateMutables,
  type FixtureUsers,
} from "./fixtures";

const DAY = "2037-06-10";
const at = (time: string) => pfaWallClockToUtc(DAY, time);

// Sentinels chosen to look like the real thing they are standing in for: a
// minor's name typed into a free-text field by a coach in a hurry.
const NOTE_SENTINEL = "SENTINEL-NOTE-jake-birthday-party-7yo";
const REASON_SENTINEL = "SENTINEL-REASON-tyler-makeup-lesson";
const NAMELESS_COACH_EMAIL = "sentinel-nameless-coach@pfa.invalid";

let fixtures: FixtureUsers;
let cage1: Awaited<ReturnType<typeof getSeededResources>>["cage1"];
let bullpen1: Awaited<ReturnType<typeof getSeededResources>>["bullpen1"];
let weightRoom1: Awaited<ReturnType<typeof getSeededResources>>["weightRoom1"];
let namelessCoachId: string;

/** 2:00 PM on the fixture day → a window of 13:30–17:30. */
const WINDOW: DisplayWindow = computeDisplayWindow(at("14:00"), 4);

async function seedSession(opts: {
  resourceId: string;
  coachId: string;
  start: string;
  end: string;
  note?: string | null;
}) {
  const [row] = await db
    .insert(sessionsBilling)
    .values({
      coachId: opts.coachId,
      resourceId: opts.resourceId,
      startAt: at(opts.start),
      endAt: at(opts.end),
      note: opts.note ?? null,
      ratePer30MinCents: 2200,
      createdBy: fixtures.admin.id,
    })
    .returning({ id: sessionsBilling.id });
  return row.id;
}

async function seedBlock(opts: {
  resourceId: string;
  start: string;
  end: string;
  reason: string;
}) {
  await db.insert(blockedTimes).values({
    resourceId: opts.resourceId,
    startAt: at(opts.start),
    endAt: at(opts.end),
    reason: opts.reason,
    createdBy: fixtures.admin.id,
  });
}

beforeAll(async () => {
  fixtures = await ensureFixtureUsers();
  const seeded = await getSeededResources();
  cage1 = seeded.cage1;
  bullpen1 = seeded.bullpen1;
  weightRoom1 = seeded.weightRoom1;

  // A coach row with a NULL name. Inserted directly rather than through the
  // app because this is a DATA STATE, not a value the code under test
  // computes — rule 33's concern (a fixture asserting what the feature is
  // supposed to decide) does not apply to "this column happens to be null".
  await db.delete(users).where(eq(users.email, NAMELESS_COACH_EMAIL));
  const [nameless] = await db
    .insert(users)
    .values({ email: NAMELESS_COACH_EMAIL, name: null, role: "coach" })
    .returning({ id: users.id });
  namelessCoachId = nameless.id;
});

afterAll(async () => {
  await truncateMutables();
  await db.delete(users).where(eq(users.email, NAMELESS_COACH_EMAIL));
});

beforeEach(async () => {
  await truncateMutables();
});

afterEach(async () => {
  await truncateMutables();
});

describe("🔴 PII — the fields that must never reach a public page", () => {
  it("never returns a session's free-text note", async () => {
    await seedSession({
      resourceId: cage1.id,
      coachId: fixtures.coach.id,
      start: "14:00",
      end: "15:00",
      note: NOTE_SENTINEL,
    });

    const result = await fetchDisplaySchedule(WINDOW);

    // Positive control FIRST: prove the row is actually in the result, so
    // the absence assertion below cannot pass because the fixture silently
    // failed to seed (discipline rule 21).
    expect(result.sessions).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(NOTE_SENTINEL);
  });

  it("never returns a block's free-text reason", async () => {
    await seedBlock({
      resourceId: cage1.id,
      start: "14:00",
      end: "15:00",
      reason: REASON_SENTINEL,
    });

    const result = await fetchDisplaySchedule(WINDOW);

    expect(result.blocks).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(REASON_SENTINEL);
  });

  it("never returns a coach's email address", async () => {
    await seedSession({
      resourceId: cage1.id,
      coachId: fixtures.coach.id,
      start: "14:00",
      end: "15:00",
    });

    const result = await fetchDisplaySchedule(WINDOW);

    expect(result.sessions).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("@pfa.invalid");
  });

  it("🔴 falls back to a neutral label, NOT the email, for a coach with no name", async () => {
    // The edge case nobody tests, and the one where `/master/schedule`'s
    // `coachName ?? coachEmail` would put a personal email address on a wall
    // screen in a room the public walks through.
    await seedSession({
      resourceId: cage1.id,
      coachId: namelessCoachId,
      start: "14:00",
      end: "15:00",
    });

    const result = await fetchDisplaySchedule(WINDOW);

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].coachLabel).toBe(DISPLAY_UNNAMED_COACH_LABEL);
    expect(JSON.stringify(result)).not.toContain(NAMELESS_COACH_EMAIL);
  });

  it("returns only the keys the display needs, and no others", async () => {
    // A shape assertion to catch a field added later. Deliberately an exact
    // key-set comparison rather than a spot check: the failure mode being
    // guarded against is someone ADDING something, which a spot check
    // structurally cannot see.
    await seedSession({
      resourceId: cage1.id,
      coachId: fixtures.coach.id,
      start: "14:00",
      end: "15:00",
      note: NOTE_SENTINEL,
    });
    await seedBlock({
      resourceId: cage1.id,
      start: "15:00",
      end: "16:00",
      reason: REASON_SENTINEL,
    });

    const result = await fetchDisplaySchedule(WINDOW);

    expect(Object.keys(result.sessions[0]).sort()).toEqual(
      ["coachLabel", "endAt", "id", "isGroupSession", "resourceId", "startAt"].sort(),
    );
    expect(Object.keys(result.blocks[0]).sort()).toEqual(
      ["endAt", "id", "resourceId", "startAt"].sort(),
    );
    expect(Object.keys(result.resources[0]).sort()).toEqual(
      ["id", "name", "sortOrder", "type"].sort(),
    );
  });
});

describe("🔴 PII — the SQL projection itself, asserted separately from the mapping", () => {
  // 🔴 THIS BLOCK EXISTS BECAUSE A MUTATION SWEEP PROVED THE TESTS ABOVE WERE
  // NOT WATCHING IT. Putting `note: sessionsBilling.note` back into the
  // SELECT broke nothing: `fetchDisplaySchedule` rebuilds each session as an
  // explicit object, so the mapping silently dropped the leaked column again.
  // Two layers of defence, and every test was pointed at the second one.
  //
  // These assert the FIRST layer — the projection — by reading the rows
  // before any mapping happens. Same idea as discipline rule 26: at least one
  // test has to enter at the TOP of the pipeline.
  it("the session projection never selects note or email", async () => {
    await seedSession({
      resourceId: cage1.id,
      coachId: fixtures.coach.id,
      start: "14:00",
      end: "15:00",
      note: NOTE_SENTINEL,
    });

    const rows = await fetchDisplayScheduleRows(WINDOW);

    expect(rows.sessions).toHaveLength(1);
    expect(Object.keys(rows.sessions[0]).sort()).toEqual(
      ["coachName", "endAt", "id", "isGroupSession", "resourceId", "startAt"].sort(),
    );
    expect(JSON.stringify(rows)).not.toContain(NOTE_SENTINEL);
    expect(JSON.stringify(rows)).not.toContain("@pfa.invalid");
  });

  it("the block projection never selects reason", async () => {
    await seedBlock({
      resourceId: cage1.id,
      start: "14:00",
      end: "15:00",
      reason: REASON_SENTINEL,
    });

    const rows = await fetchDisplayScheduleRows(WINDOW);

    expect(rows.blocks).toHaveLength(1);
    expect(Object.keys(rows.blocks[0]).sort()).toEqual(
      ["endAt", "id", "resourceId", "startAt"].sort(),
    );
    expect(JSON.stringify(rows)).not.toContain(REASON_SENTINEL);
  });
});

describe("retired equipment stays off the wall", () => {
  it("excludes an INACTIVE resource and its sessions", async () => {
    // 🔴 ALSO ADDED BECAUSE A MUTATION SURVIVED. Deleting the
    // `WHERE active = true` filter broke no test, because the seeded dev
    // branch happens to contain no inactive resources — the guard was
    // untestable rather than untested (discipline rule 27: ask which).
    // A decommissioned cage still rendering on the facility TV is a real
    // outcome, so the fixture now makes it reachable.
    const [retired] = await db
      .insert(resources)
      .values({
        name: "SENTINEL Retired Cage",
        type: "cage",
        sortOrder: 9999,
        active: false,
      })
      .returning({ id: resources.id });

    try {
      await seedSession({
        resourceId: retired.id,
        coachId: fixtures.coach.id,
        start: "14:00",
        end: "15:00",
      });

      const result = await fetchDisplaySchedule(WINDOW);

      expect(result.resources.map((r) => r.id)).not.toContain(retired.id);
      expect(JSON.stringify(result)).not.toContain("SENTINEL Retired Cage");

      // Positive control: an ACTIVE resource is present in the same call, so
      // this is not passing because the query returned nothing at all.
      expect(result.resources.map((r) => r.id)).toContain(cage1.id);
    } finally {
      await db.delete(sessionsBilling).where(eq(sessionsBilling.resourceId, retired.id));
      await db.delete(resources).where(eq(resources.id, retired.id));
    }
  });
});

describe("the rolling window uses OVERLAP, not containment", () => {
  it("🔴 returns a session already in progress when the window opened", async () => {
    // Started at 1:00 PM, still running. The window opens at 1:30 PM. This
    // is the single most important bar on a 2 PM screen and the entire
    // reason the lookback exists.
    await seedSession({
      resourceId: cage1.id,
      coachId: fixtures.coach.id,
      start: "13:00",
      end: "15:00",
    });

    const result = await fetchDisplaySchedule(WINDOW);
    expect(result.sessions).toHaveLength(1);
  });

  it("and that session starts BEFORE the window — the control for the test above", async () => {
    // Without this, the test above would pass just as well against a
    // containment filter if the fixture happened to start inside the window.
    expect(at("13:00").getTime()).toBeLessThan(WINDOW.startAt.getTime());
  });

  it("returns a session that runs off the right-hand edge", async () => {
    await seedSession({
      resourceId: cage1.id,
      coachId: fixtures.coach.id,
      start: "17:00",
      end: "19:00",
    });
    expect((await fetchDisplaySchedule(WINDOW)).sessions).toHaveLength(1);
  });

  it("excludes a session that ended exactly as the window opened", async () => {
    await seedSession({
      resourceId: cage1.id,
      coachId: fixtures.coach.id,
      start: "12:00",
      end: "13:30",
    });
    expect((await fetchDisplaySchedule(WINDOW)).sessions).toHaveLength(0);
  });

  it("excludes a session that starts exactly as the window closes", async () => {
    await seedSession({
      resourceId: cage1.id,
      coachId: fixtures.coach.id,
      start: "17:30",
      end: "18:30",
    });
    expect((await fetchDisplaySchedule(WINDOW)).sessions).toHaveLength(0);
  });

  it("excludes sessions wholly outside the window on either side", async () => {
    await seedSession({
      resourceId: cage1.id,
      coachId: fixtures.coach.id,
      start: "09:00",
      end: "10:00",
    });
    await seedSession({
      resourceId: cage1.id,
      coachId: fixtures.coach.id,
      start: "19:00",
      end: "20:00",
    });
    expect((await fetchDisplaySchedule(WINDOW)).sessions).toHaveLength(0);
  });

  it("applies the same overlap rule to blocks", async () => {
    await seedBlock({ resourceId: cage1.id, start: "13:00", end: "14:00", reason: "in progress" });
    await seedBlock({ resourceId: cage1.id, start: "09:00", end: "10:00", reason: "outside" });
    const result = await fetchDisplaySchedule(WINDOW);
    expect(result.blocks).toHaveLength(1);
  });
});

describe("resource coverage — Mark asked for the whole facility", () => {
  it("returns cages, the bullpen AND the weight room, with no type filter", async () => {
    const result = await fetchDisplaySchedule(WINDOW);
    const types = new Set(result.resources.map((r) => r.type));
    expect(types.has("cage")).toBe(true);
    expect(types.has("bullpen")).toBe(true);
    expect(types.has("weight_room")).toBe(true);
  });

  it("carries sessions on all three resource types", async () => {
    for (const resourceId of [cage1.id, bullpen1.id, weightRoom1.id]) {
      await seedSession({
        resourceId,
        coachId: fixtures.coach.id,
        start: "14:00",
        end: "15:00",
      });
    }
    const result = await fetchDisplaySchedule(WINDOW);
    expect(result.sessions).toHaveLength(3);
    expect(new Set(result.sessions.map((s) => s.resourceId))).toEqual(
      new Set([cage1.id, bullpen1.id, weightRoom1.id]),
    );
  });

  it("orders resources by sortOrder so the rows do not shuffle between refreshes", async () => {
    // A grid whose rows reorder every 30 seconds is unreadable on a wall.
    const result = await fetchDisplaySchedule(WINDOW);
    const orders = result.resources.map((r) => r.sortOrder);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
  });
});
