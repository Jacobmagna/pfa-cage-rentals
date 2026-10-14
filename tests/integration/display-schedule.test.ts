// Integration tests for src/lib/server/display-schedule.ts — the ONLY query
// behind the unauthenticated facility TV display. Hits the real Neon dev
// branch.
//
// 🔴 THE FIRST DESCRIBE BLOCK IS THE POINT OF THIS FILE. The display page has
// no auth gate, and nothing in this repo gates routes centrally (src/proxy.ts
// only routes by host), so the projection and the label rule in
// display-schedule.ts are the only things standing between a
// free-text field somebody typed and the public internet. These tests seed
// UNIQUE SENTINEL STRINGS into the free-text fields and assert on where each
// one does and does not appear in the serialized result — rather than
// asserting that some property is undefined, which would pass just as happily
// against a result shape that had quietly grown a new column.
//
// 📌 THREE EXPECTATIONS, THREE SENTINELS (since 2026-10-13, when the facility
// owner decided the note on a block she enters by hand is printed on the wall
// as typed — before that a block's reason was a never-escape field too):
//   · a session's note, a coach's email — never, in the rows or the result;
//   · a HAND-ENTERED block's note       — printed as that block's label, and
//     present nowhere else in the result;
//   · a PROGRAM-MADE block's reason     — read by the query, never printed.
//
// Every fixture is dated in 2037, a year no other suite in this repo uses
// (2029 admin-hour-entry, 2031 multi-coach, 2033 approval-sync, 2035 no-show
// horizon) — discipline rule 20, because this module reads across whole
// tables rather than scoping to its own rows.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  blockedTimes,
  programScheduleBlocks,
  programs,
  resources,
  sessionsBilling,
  users,
} from "@/db/schema";
import { PROGRAM_NAMES as SEEDED_PROGRAM_NAMES } from "@/db/seed-programs";
import { programOccupancyReason } from "@/lib/server/program-resource-blocks";
import { pfaWallClockToUtc } from "@/lib/timezone";
import { computeDisplayWindow, type DisplayWindow } from "@/lib/display/window";
import {
  DISPLAY_BLOCKED_LABEL,
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
// The note on a block an admin entered by hand. This one IS printed.
const REASON_SENTINEL = "SENTINEL-REASON-tyler-makeup-lesson";
// The reason on a row a scheduled PROGRAM owns. Never printed. Deliberately
// NOT shaped like the app's auto text (`Program: <name>`): what withholds it
// is the row's link to a program block, not what the text looks like.
const PROGRAM_ROW_REASON_SENTINEL = "SENTINEL-PROGRAM-ROW-REASON-must-not-print";
const NAMELESS_COACH_EMAIL = "sentinel-nameless-coach@pfa.invalid";

const ZERO_WIDTH_ONLY = "\u200B\u200D";

/** How many times `needle` occurs in everything `value` serializes to. */
function occurrences(value: unknown, needle: string): number {
  return JSON.stringify(value).split(needle).length - 1;
}

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
  // 🔴 PRE-CLEAN, BEFORE ANYTHING IS SEEDED. A run that is KILLED mid-test
  // never reaches afterEach, and what it leaves behind breaks the next run in
  // a way that reads like a flake: a fixture program trips
  // `programs_name_unique` (23505) in the seed helper, and a booking by the
  // nameless coach blocks deleting that coach below (23503). Mutables first —
  // a leftover tagged block references its program — then this file's own
  // programs.
  await truncateMutables();
  await removeFixturePrograms();

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

/**
 * EVERY program this file inserts, in one place.
 *
 * 🔴 THIS LIST IS WHAT THE CLEANUP DELETES BY, SO IT IS ALSO WHAT KEEPS THE
 * CLEANUP AWAY FROM REAL ROWS. `truncateMutables` clears `blocked_times` but
 * not `programs` or `program_schedule_blocks`, and `programs.name` is UNIQUE,
 * so these rows have to be removed by this file — after every test, and
 * before the first one in case an earlier run was killed (see beforeAll).
 * Deleting by NAME on a shared database is only safe if no real program can
 * carry one of these names, so:
 *
 *   · every name starts with FIXTURE_PROGRAM_PREFIX, which no real program
 *     does;
 *   · none is a name `src/db/seed-programs.ts` seeds — CI runs `npm run
 *     db:seed` before this suite, and borrowing a seeded name was 26 days of
 *     red CI (rule 57). A test at the bottom of this file asserts both.
 *
 * `insertFixtureProgram` is the only place this file inserts a program, and
 * it refuses a name that is not on this list.
 */
const FIXTURE_PROGRAM_PREFIX = "Display Fixture — ";
const FIXTURE_PROGRAMS = {
  autoReason: `${FIXTURE_PROGRAM_PREFIX}Auto Reason Program`,
  linkedHandTypedReason: `${FIXTURE_PROGRAM_PREFIX}Hand-Typed-Looking Reason`,
  hsHitting: `${FIXTURE_PROGRAM_PREFIX}High School Program Hitting`,
  bullpenDevelopment: `${FIXTURE_PROGRAM_PREFIX}Bullpen Development`,
  taggedHitting: `${FIXTURE_PROGRAM_PREFIX}Tagged Hitting`,
  taggedBlankNote: `${FIXTURE_PROGRAM_PREFIX}Tagged Blank Note`,
  taggedYouthCamp: `${FIXTURE_PROGRAM_PREFIX}Tagged Youth Camp`,
  tagThatMustLose: `${FIXTURE_PROGRAM_PREFIX}Tag That Must Lose`,
  realOccupancy: `${FIXTURE_PROGRAM_PREFIX}Real Occupancy`,
  travelBallInfield: `${FIXTURE_PROGRAM_PREFIX}Travel Ball Infield`,
} as const;
type FixtureProgramName = (typeof FIXTURE_PROGRAMS)[keyof typeof FIXTURE_PROGRAMS];
const FIXTURE_PROGRAM_NAMES: string[] = Object.values(FIXTURE_PROGRAMS);

async function insertFixtureProgram(
  name: FixtureProgramName,
  displayName: string | null,
): Promise<string> {
  // Vitest does not typecheck, so the type above is not enough on its own.
  if (!FIXTURE_PROGRAM_NAMES.includes(name)) {
    throw new Error(
      `"${name}" is not in FIXTURE_PROGRAMS — add it there, or the cleanup will never remove it`,
    );
  }
  const [program] = await db
    .insert(programs)
    .values({ name, displayName })
    .returning({ id: programs.id });
  return program.id;
}

/**
 * Removes this file's fixture programs and everything hanging off them, found
 * by the exact names in FIXTURE_PROGRAMS. Returns how many programs it removed.
 *
 * Children first, because neither foreign key cascades: a tagged block points
 * at its program through `display_program_id`, and a program schedule block
 * through `program_id`. (A program block's linked `blocked_times` rows DO
 * cascade away with it.)
 */
async function removeFixturePrograms(): Promise<number> {
  const rows = await db
    .select({ id: programs.id })
    .from(programs)
    .where(inArray(programs.name, FIXTURE_PROGRAM_NAMES));
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return 0;
  await db.delete(blockedTimes).where(inArray(blockedTimes.displayProgramId, ids));
  await db
    .delete(programScheduleBlocks)
    .where(inArray(programScheduleBlocks.programId, ids));
  await db.delete(programs).where(inArray(programs.id, ids));
  return ids.length;
}

/**
 * A block that a scheduled PROGRAM owns: it carries the program's name onto
 * the wall, and its own `reason` never.
 */
async function seedProgramBlock(opts: {
  resourceId: string;
  start: string;
  end: string;
  programName: FixtureProgramName;
  programDisplayName?: string | null;
  reason: string;
}) {
  const programId = await insertFixtureProgram(
    opts.programName,
    opts.programDisplayName ?? null,
  );

  const [scheduleBlock] = await db
    .insert(programScheduleBlocks)
    .values({
      programId,
      startAt: at(opts.start),
      endAt: at(opts.end),
      createdBy: fixtures.admin.id,
    })
    .returning({ id: programScheduleBlocks.id });

  await db.insert(blockedTimes).values({
    resourceId: opts.resourceId,
    startAt: at(opts.start),
    endAt: at(opts.end),
    reason: opts.reason,
    programScheduleBlockId: scheduleBlock.id,
    createdBy: fixtures.admin.id,
  });
}

/**
 * A HAND-ENTERED block carrying only the cosmetic program tag — no
 * program_schedule_block, so nothing about pay or attendance is involved.
 * This is the shape an admin creates from the master schedule's Block form.
 */
async function seedTaggedBlock(opts: {
  resourceId: string;
  start: string;
  end: string;
  programName: FixtureProgramName;
  programDisplayName?: string | null;
  reason: string;
}) {
  const programId = await insertFixtureProgram(
    opts.programName,
    opts.programDisplayName ?? null,
  );

  await db.insert(blockedTimes).values({
    resourceId: opts.resourceId,
    startAt: at(opts.start),
    endAt: at(opts.end),
    reason: opts.reason,
    displayProgramId: programId,
    createdBy: fixtures.admin.id,
  });
  return programId;
}

beforeEach(async () => {
  await truncateMutables();
});

afterEach(async () => {
  await truncateMutables();
  await removeFixturePrograms();
});

describe("🔴 PII — what may and may not reach a public page", () => {
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
    expect(result.sessions[0].coachLabel).toBe("Integration Coach");
    expect(JSON.stringify(result)).not.toContain(NOTE_SENTINEL);
  });

  // 🔴 RE-POINTED 2026-10-13. This test used to assert the opposite — that a
  // block's reason is absent from the result. The facility owner decided the
  // note on a block she enters by hand is printed on the wall as typed, so
  // the guard is now about WHERE the note may appear: as that block's label,
  // and nowhere else in what the page receives.
  it("🔴 a HAND-ENTERED block's note is its label, and appears nowhere else", async () => {
    await seedBlock({
      resourceId: cage1.id,
      start: "14:00",
      end: "15:00",
      reason: REASON_SENTINEL,
    });

    const result = await fetchDisplaySchedule(WINDOW);

    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].label).toBe(REASON_SENTINEL);
    // Exactly once: the label. A second occurrence would mean the raw
    // `reason` column is riding along on the mapped block as well.
    expect(occurrences(result, REASON_SENTINEL)).toBe(1);
    expect(Object.keys(result.blocks[0]).sort()).toEqual(
      ["endAt", "id", "label", "resourceId", "startAt"].sort(),
    );
  });

  it("🔴 a PROGRAM-MADE block's auto `Program: …` reason is never printed", async () => {
    // The reason is written by the app's own function, so this is the text a
    // real program block carries rather than a guess at it.
    const programName = FIXTURE_PROGRAMS.autoReason;
    const autoReason = programOccupancyReason(programName);
    await seedProgramBlock({
      resourceId: cage1.id,
      start: "14:00",
      end: "15:00",
      programName,
      programDisplayName: "0af Auto",
      reason: autoReason,
    });

    const rows = await fetchDisplayScheduleRows(WINDOW);
    const result = await fetchDisplaySchedule(WINDOW);

    // Positive controls: the reason really is on the row the query reads, the
    // row really is program-made, and the block really is in the result. So
    // the absence below is the label rule withholding it — not a fixture that
    // never wrote it.
    expect(autoReason).toBe(`Program: ${programName}`);
    expect(rows.blocks).toHaveLength(1);
    expect(rows.blocks[0].reason).toBe(autoReason);
    expect(rows.blocks[0].programScheduleBlockId).not.toBeNull();
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].label).toBe("0af Auto");

    expect(JSON.stringify(result)).not.toContain("Program:");
    expect(JSON.stringify(result)).not.toContain(programName);
    expect(Object.keys(result.blocks[0]).sort()).toEqual(
      ["endAt", "id", "label", "resourceId", "startAt"].sort(),
    );
  });

  it("🔴 ...and neither is a program-made row's reason that LOOKS hand-typed", async () => {
    // What withholds the reason is the row's link to a program block, not the
    // shape of the text. A rule keyed on the `Program:` prefix would print
    // this one.
    await seedProgramBlock({
      resourceId: cage1.id,
      start: "14:00",
      end: "15:00",
      programName: FIXTURE_PROGRAMS.linkedHandTypedReason,
      programDisplayName: "0af Linked",
      reason: PROGRAM_ROW_REASON_SENTINEL,
    });

    const rows = await fetchDisplayScheduleRows(WINDOW);
    const result = await fetchDisplaySchedule(WINDOW);

    expect(rows.blocks).toHaveLength(1);
    expect(rows.blocks[0].reason).toBe(PROGRAM_ROW_REASON_SENTINEL);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].label).toBe("0af Linked");
    expect(JSON.stringify(result)).not.toContain(PROGRAM_ROW_REASON_SENTINEL);
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
    // structurally cannot see. `reason` and `programScheduleBlockId` are read
    // by the query and must NOT be among a mapped block's keys.
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
      ["endAt", "id", "label", "resourceId", "startAt"].sort(),
    );
    expect(Object.keys(result.resources[0]).sort()).toEqual(
      ["id", "name", "sortOrder", "type"].sort(),
    );
    // And the session's note is still nowhere, in the same result that does
    // carry the block's note as a label.
    expect(result.blocks[0].label).toBe(REASON_SENTINEL);
    expect(JSON.stringify(result)).not.toContain(NOTE_SENTINEL);
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

  // 🔴 RE-POINTED 2026-10-13: this used to assert `reason` was NOT selected.
  // It is selected now, together with the link that says whether the row is
  // hand-entered. The assertion is still an EXACT key set, so the next column
  // added to this projection fails here until someone decides it belongs.
  it("the block projection selects reason and the program link, and nothing else new", async () => {
    await seedSession({
      resourceId: bullpen1.id,
      coachId: fixtures.coach.id,
      start: "14:00",
      end: "15:00",
      note: NOTE_SENTINEL,
    });
    await seedBlock({
      resourceId: cage1.id,
      start: "14:00",
      end: "15:00",
      reason: REASON_SENTINEL,
    });

    const rows = await fetchDisplayScheduleRows(WINDOW);

    expect(rows.blocks).toHaveLength(1);
    expect(Object.keys(rows.blocks[0]).sort()).toEqual(
      [
        "endAt",
        "id",
        "programDisplayName",
        "programName",
        "programScheduleBlockId",
        "reason",
        "resourceId",
        "startAt",
        "tagDisplayName",
        "tagName",
      ].sort(),
    );
    // The raw row carries the note as typed, and a hand-entered row has no
    // program link — the two facts the label rule reads.
    expect(rows.blocks[0].reason).toBe(REASON_SENTINEL);
    expect(rows.blocks[0].programScheduleBlockId).toBeNull();
    // Selecting a block's note did not bring a session's note with it.
    expect(rows.sessions).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(NOTE_SENTINEL);
  });
});

describe("blocked bars say WHAT is blocking them", () => {
  // Two requests, two sources. 2026-08-30 (Mark's wife via Jacob): a bar a
  // scheduled program owns carries the program's name, from `programs`.
  // 2026-10-13 (the facility owner): a bar she enters by hand carries the note
  // she typed. The safety line is that a PROGRAM-MADE row's reason is never
  // the label.

  it("shows the program's SHORT display name when one is set", async () => {
    await seedProgramBlock({
      resourceId: cage1.id,
      start: "14:00",
      end: "15:00",
      programName: FIXTURE_PROGRAMS.hsHitting,
      programDisplayName: "HS Hitting",
      reason: PROGRAM_ROW_REASON_SENTINEL,
    });

    const result = await fetchDisplaySchedule(WINDOW);

    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].label).toBe("HS Hitting");
    // The long name is not on the wall either — the short form REPLACES it.
    expect(JSON.stringify(result)).not.toContain(FIXTURE_PROGRAMS.hsHitting);
    expect(JSON.stringify(result)).not.toContain("High School Program");
    expect(JSON.stringify(result)).not.toContain(PROGRAM_ROW_REASON_SENTINEL);
  });

  it("falls back to the full program name when no short name is set", async () => {
    await seedProgramBlock({
      resourceId: cage1.id,
      start: "14:00",
      end: "15:00",
      programName: FIXTURE_PROGRAMS.bullpenDevelopment,
      programDisplayName: null,
      reason: PROGRAM_ROW_REASON_SENTINEL,
    });

    const result = await fetchDisplaySchedule(WINDOW);

    expect(result.blocks[0].label).toBe(FIXTURE_PROGRAMS.bullpenDevelopment);
    expect(JSON.stringify(result)).not.toContain(PROGRAM_ROW_REASON_SENTINEL);
  });

  // 🔴 THIS IS THE REGRESSION TEST FOR THE JOIN TYPE, AND IT IS THE MOST
  // IMPORTANT ONE IN THIS BLOCK. A hand-entered block has a NULL
  // program_schedule_block_id. If a join is ever "tidied" from LEFT to
  // INNER, this row vanishes from the query — and a cage that is UNAVAILABLE
  // renders as FREE, which is the exact failure the red bar exists to prevent.
  // It fails on the length assertion before it ever reaches the label.
  it("keeps a hand-entered block on the board, labelled with its note", async () => {
    await seedBlock({
      resourceId: cage1.id,
      start: "14:00",
      end: "15:00",
      reason: REASON_SENTINEL,
    });

    const result = await fetchDisplaySchedule(WINDOW);

    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].label).toBe(REASON_SENTINEL);
  });

  it("prints the note trimmed at its ends", async () => {
    await seedBlock({
      resourceId: cage1.id,
      start: "14:00",
      end: "15:00",
      reason: `  ${REASON_SENTINEL} \n`,
    });

    const result = await fetchDisplaySchedule(WINDOW);

    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].label).toBe(REASON_SENTINEL);
  });

  // 📌 `blocked_times.reason` is NOT NULL with no CHECK, so an empty or
  // whitespace-only value CAN be stored — the first two inserts succeed. The admin
  // forms trim the note before sending it, but `createBlockSchema` itself is
  // `min(1)` with no trim: it refuses "" and accepts " ". So a blank note is a
  // state the display has to survive, and an empty bar reads as a free cage.
  it("a hand-entered block with a blank note and no tag stays 'Blocked'", async () => {
    await seedBlock({ resourceId: cage1.id, start: "14:00", end: "15:00", reason: "" });
    await seedBlock({ resourceId: bullpen1.id, start: "14:00", end: "15:00", reason: " \t " });
    // Zero-width space + zero-width joiner: not whitespace, so `trim()` keeps
    // them, and nothing visible. Written as escapes so they can be seen here.
    await seedBlock({
      resourceId: weightRoom1.id,
      start: "14:00",
      end: "15:00",
      reason: ZERO_WIDTH_ONLY,
    });

    const rows = await fetchDisplayScheduleRows(WINDOW);
    const result = await fetchDisplaySchedule(WINDOW);

    // Positive control: the blank values really were stored as written.
    expect(rows.blocks.map((b) => b.reason).sort()).toEqual(
      ["", " \t ", ZERO_WIDTH_ONLY].sort(),
    );
    expect(ZERO_WIDTH_ONLY.trim()).toHaveLength(2);
    expect(result.blocks).toHaveLength(3);
    expect(result.blocks.map((b) => b.label)).toEqual([
      DISPLAY_BLOCKED_LABEL,
      DISPLAY_BLOCKED_LABEL,
      DISPLAY_BLOCKED_LABEL,
    ]);
  });

  // ── the COSMETIC tag an admin picks in the Block form ──────────────────
  // These are hand-entered blocks with NO program_schedule_block. Nothing here
  // touches scheduling, hours or pay. Since 2026-10-13 the tag is only what
  // the wall falls back to when the block has no note to print.

  it("🔴 a hand-entered block TAGGED with a program shows the NOTE, not the tag", async () => {
    await seedTaggedBlock({
      resourceId: cage1.id,
      start: "14:00",
      end: "15:00",
      programName: FIXTURE_PROGRAMS.taggedHitting,
      programDisplayName: "Hitting Program",
      reason: REASON_SENTINEL,
    });

    const rows = await fetchDisplayScheduleRows(WINDOW);
    const result = await fetchDisplaySchedule(WINDOW);

    // Positive control: the tag really is set on this row, so the note beat a
    // tag that exists rather than one the fixture failed to attach.
    expect(rows.blocks).toHaveLength(1);
    expect(rows.blocks[0].tagDisplayName).toBe("Hitting Program");
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].label).toBe(REASON_SENTINEL);
    expect(JSON.stringify(result)).not.toContain("Hitting Program");
    expect(JSON.stringify(result)).not.toContain(FIXTURE_PROGRAM_PREFIX);
  });

  it("a tagged block with a whitespace-only note shows the tag's short name", async () => {
    await seedTaggedBlock({
      resourceId: cage1.id,
      start: "14:00",
      end: "15:00",
      programName: FIXTURE_PROGRAMS.taggedBlankNote,
      programDisplayName: "Blank Note Tag",
      reason: "   ",
    });

    const result = await fetchDisplaySchedule(WINDOW);

    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].label).toBe("Blank Note Tag");
  });

  it("a tagged block with a blank note falls back to the full program name with no short form", async () => {
    await seedTaggedBlock({
      resourceId: cage1.id,
      start: "14:00",
      end: "15:00",
      programName: FIXTURE_PROGRAMS.taggedYouthCamp,
      programDisplayName: null,
      reason: " ",
    });

    const result = await fetchDisplaySchedule(WINDOW);

    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].label).toBe(FIXTURE_PROGRAMS.taggedYouthCamp);
  });

  // 🔴 REAL OCCUPANCY OUTRANKS THE COSMETIC TAG, and this is the test that
  // pins the precedence. If a scheduled program owns the slot, that is what
  // the slot IS; a tag someone also set cannot rename it. Reversing the ??
  // chain in the label rule turns this red.
  it("a program-linked block ignores a cosmetic tag set on the same row", async () => {
    const tagProgramId = await insertFixtureProgram(
      FIXTURE_PROGRAMS.tagThatMustLose,
      "TAG LOSES",
    );
    const realProgramId = await insertFixtureProgram(
      FIXTURE_PROGRAMS.realOccupancy,
      "REAL WINS",
    );

    const [scheduleBlock] = await db
      .insert(programScheduleBlocks)
      .values({
        programId: realProgramId,
        startAt: at("14:00"),
        endAt: at("15:00"),
        createdBy: fixtures.admin.id,
      })
      .returning({ id: programScheduleBlocks.id });

    await db.insert(blockedTimes).values({
      resourceId: cage1.id,
      startAt: at("14:00"),
      endAt: at("15:00"),
      reason: PROGRAM_ROW_REASON_SENTINEL,
      programScheduleBlockId: scheduleBlock.id,
      displayProgramId: tagProgramId,
      createdBy: fixtures.admin.id,
    });

    const result = await fetchDisplaySchedule(WINDOW);

    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].label).toBe("REAL WINS");
    expect(JSON.stringify(result)).not.toContain("TAG LOSES");
    expect(JSON.stringify(result)).not.toContain(PROGRAM_ROW_REASON_SENTINEL);
  });

  it("shows both kinds side by side without losing either", async () => {
    await seedProgramBlock({
      resourceId: cage1.id,
      start: "14:00",
      end: "15:00",
      programName: FIXTURE_PROGRAMS.travelBallInfield,
      programDisplayName: "Travel INF",
      reason: PROGRAM_ROW_REASON_SENTINEL,
    });
    await seedBlock({
      resourceId: bullpen1.id,
      start: "14:00",
      end: "15:00",
      reason: REASON_SENTINEL,
    });

    const result = await fetchDisplaySchedule(WINDOW);

    expect(result.blocks).toHaveLength(2);
    // Each kind takes its label from its own source, on the same call: the
    // hand-entered bar its note, the program bar its program's short name.
    expect(result.blocks.map((b) => b.label).sort()).toEqual(
      [REASON_SENTINEL, "Travel INF"].sort(),
    );
    expect(JSON.stringify(result)).not.toContain(PROGRAM_ROW_REASON_SENTINEL);
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

describe("this file's own fixture programs", () => {
  // The cleanup deletes programs BY NAME on a shared database (see
  // FIXTURE_PROGRAMS). These are what make that safe.
  it("none borrows a name the seed script inserts, and every one carries the fixture prefix", () => {
    expect(FIXTURE_PROGRAM_NAMES.length).toBeGreaterThan(0);
    expect(SEEDED_PROGRAM_NAMES.length).toBeGreaterThan(0);
    for (const name of FIXTURE_PROGRAM_NAMES) {
      expect(name.startsWith(FIXTURE_PROGRAM_PREFIX), name).toBe(true);
      expect(SEEDED_PROGRAM_NAMES as readonly string[], name).not.toContain(name);
    }
    for (const seeded of SEEDED_PROGRAM_NAMES) {
      expect(seeded.startsWith(FIXTURE_PROGRAM_PREFIX), seeded).toBe(false);
    }
    expect(new Set(FIXTURE_PROGRAM_NAMES).size).toBe(FIXTURE_PROGRAM_NAMES.length);
  });

  it("the cleanup leaves none of them behind, and leaves every other program alone", async () => {
    const before = await db.select({ id: programs.id }).from(programs);
    await seedProgramBlock({
      resourceId: cage1.id,
      start: "14:00",
      end: "15:00",
      programName: FIXTURE_PROGRAMS.hsHitting,
      reason: PROGRAM_ROW_REASON_SENTINEL,
    });
    await seedTaggedBlock({
      resourceId: bullpen1.id,
      start: "14:00",
      end: "15:00",
      programName: FIXTURE_PROGRAMS.taggedHitting,
      reason: REASON_SENTINEL,
    });

    // Without clearing the tagged block first, exactly as beforeAll meets a
    // killed run's leftovers after its truncate — here the function has to
    // remove the tagged block itself.
    expect(await removeFixturePrograms()).toBe(2);

    const after = await db.select({ id: programs.id }).from(programs);
    expect(after.map((r) => r.id).sort()).toEqual(before.map((r) => r.id).sort());
    expect(await removeFixturePrograms()).toBe(0);
  });
});
