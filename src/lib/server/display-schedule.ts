// The ONLY query that feeds the public TV display.
//
// 🔴🔴 THIS MODULE IS THE PII BOUNDARY OF THE ENTIRE FEATURE. Read this
// header before changing a single select.
//
// The display page is UNAUTHENTICATED. There is no middleware in this repo —
// every other schedule surface is gated by a `requireRole` / `requireScheduleAccess`
// call inside its own server component, and this one deliberately has no such
// call. So nothing structural stops a field from reaching the public internet;
// the only things that stop it are the projection list below and, for the one
// free-text column that IS selected, `resolveDisplayBlockLabel`.
//
// 🔴 TWO FIELDS MUST NEVER BE SELECTED HERE: `sessionsBilling.note` and
// `users.email`. A third, `blockedTimes.reason`, was on this list until
// 2026-10-13 and IS selected now — read "THE BLOCK NOTE" below before
// touching it.
//
// ⚠️ FIRST, A CORRECTION TO THE OBVIOUS VERSION OF THIS WARNING, because the
// obvious version is WRONG and was measured rather than reasoned about
// (2026-08-27). It is tempting to write "not rendered is not not-sent — any
// value reaching a server component lands in the RSC payload". That is FALSE
// as stated, and shipping it would be a confident-sounding claim a future
// reader would trust. What was actually probed, by injecting a sentinel and
// reading the served bytes:
//
//   · a value passed to a SERVER component and never rendered does NOT reach
//     the page source. Server components render on the server; only their
//     OUTPUT is sent.
//   · a value passed to a CLIENT component and never rendered DOES reach the
//     page source, serialized into the RSC payload. Confirmed with a literal
//     probe string on StaleGuard's props.
//
// 🔴 SO THE REAL HAZARD IS SHARPER AND EASIER TO TRIP OVER, AND SINCE
// 2026-10-13 THERE IS SOMETHING IN THIS FILE FOR IT TO PUBLISH. The raw rows
// read below carry `reason` for EVERY block, including the program-made ones
// whose reason is never printed. What keeps it in is the mapping in
// `fetchDisplaySchedule`: it rebuilds each block field by field, and the only
// text on the result is `label`. `DisplayGrid` is a server component and is
// handed that mapped result, never a raw row. THE DAY SOMEBODY ADDS
// `"use client"` TO IT — for an animation, a marquee, a ticking clock — every
// prop it receives becomes serialized. That is a one-line change in a
// different file, made for an unrelated reason, by someone who will not read
// this comment. On that day the mapped result is what gets published, so the
// mapped result must never carry a raw column: never spread a raw row into a
// mapped object, and never hand `fetchDisplayScheduleRows`'s output to a
// component.
//
// The two fields that are never selected, and why each one matters:
//
//   · sessionsBilling.note   — free text. `/master/schedule` puts it in a
//     `title` attribute. A tooltip is invisible on a TV (no mouse) and fully
//     readable in View Source. Nothing stops a coach typing "Tyler makeup
//     lesson" or "bday party - Jake" into it. That is a MINOR'S NAME on a
//     public page.
//   · users.email            — a coach's personal email on a wall screen and
//     in a public page source.
//
// 🔴 THE BLOCK NOTE — `blockedTimes.reason` — IS SELECTED, ON PURPOSE. It is
// the same class of field as a session's note: free text, and nothing stops a
// name being typed into it. On 2026-10-13 the facility owner (Esther) decided
// that the red bars she enters by hand should say what she typed, as the
// admin grid already does, rather than "Blocked" or a program name. What
// that decision does and does not cover:
//
//   · WHERE IT IS PRINTED. Only as the label of a HAND-ENTERED block — one
//     with no `programScheduleBlockId`. A block a scheduled program owns
//     keeps the auto text `Program: <name>` in the same column
//     (`programOccupancyReason`, program-resource-blocks.ts); that is never
//     printed, and its bar shows the program's short name as before.
//     `resolveDisplayBlockLabel` is the one place this is decided.
//   · WHO CAN TYPE ONE. A hand-entered block's `reason` is written only by
//     block-actions.ts and block-series-actions.ts. Their only callers are
//     the actions in src/app/admin/schedule/actions.ts, and each of those
//     calls `requireScheduleAccess` first: an admin, or a coach flagged
//     `scheduleAdmin` (a Schedule Manager). A plain coach has no path to it.
//     The schemas those actions parse cap it at 120 characters
//     (src/lib/schemas/block.ts).
//   · WHO CAN READ IT. Everyone the display is served to: whoever is in
//     front of the TV, and anyone holding the `/display/schedule?key=` URL
//     or a `/video` cookie, in the rendered page and in its source.
//   · WHAT IT DOES NOT COVER. A session's note. The owner was explicit that
//     the note on a coach's lesson must never show; "block notes are on the
//     TV" is not permission to select `sessionsBilling.note`.
//
// ⚠️ AND THE TRAP THAT IS ALREADY IN THE CODEBASE: `/master/schedule`'s
// blockedTimes query is a BARE `db.select().from(blockedTimes)` with no
// projection — it ships every column on that table and silently gains any
// column added to it later. Copying that query shape into this file would put
// every one of those columns in the raw rows, one careless mapping away from
// the one place it actually matters. Every select here is explicit for that
// reason. Keep them explicit.
//
// The token in the URL is the SECOND layer, not the first (src/lib/display/token.ts).
// If the URL leaks, this file is what decides whether the leak is "cages,
// times, coach names, program names and the notes on hand-entered blocks" —
// which is what is already visible on a screen in a room the public walks
// through — or something worse.

import { and, asc, eq, gt, lt } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import {
  blockedTimes,
  programScheduleBlocks,
  programs,
  resources,
  sessionsBilling,
  users,
} from "@/db/schema";
import type { ResourceType } from "@/lib/billing";
import type { DisplayWindow } from "@/lib/display/window";

/**
 * The SAME programs table joined a second time, for the cosmetic tag an admin
 * picks when blocking the grid by hand (`blocked_times.display_program_id`).
 *
 * 🔴 IT IS A SEPARATE JOIN BECAUSE THE TWO ARE DIFFERENT FACTS. The first
 * join answers "a scheduled program OWNS this slot" — real occupancy that pay
 * and attendance also read. This one answers "a human said this block is for
 * that program" and is read nowhere else in the product. Collapsing them into
 * one join would make a cosmetic label indistinguishable from scheduled
 * occupancy at the point where the difference matters most.
 */
const taggedProgram = alias(programs, "tagged_program");

/**
 * What a session with no coach name renders as.
 *
 * 🔴 IT MUST NOT FALL BACK TO THE EMAIL, and that is the whole reason this
 * constant exists. `/master/schedule` does `coachName ?? coachEmail`, which is
 * correct behind auth and is exactly wrong on a public wall screen — it would
 * put a personal email address on the TV precisely in the edge case nobody
 * tests. The cage is booked; that is all the screen needs to say.
 */
export const DISPLAY_UNNAMED_COACH_LABEL = "Reserved";

/**
 * What a block with nothing to name it renders as: no program behind it, no
 * program tag, and no visible text in its note.
 *
 * 🔴 IT IS THE LAST FALLBACK, AND IT EXISTS SO A BAR IS NEVER EMPTY. An
 * outlined bar with no text in it reads as a free cage from across the room
 * (see BLOCKED_OUTLINE in display-grid.tsx). `blocked_times.reason` is NOT
 * NULL but the database accepts a blank one, so "the note is required" does
 * not mean "there is always something to print".
 *
 * Until 2026-10-13 EVERY hand-entered block rendered as this, whatever was
 * typed, because `reason` was never selected. The file header says what
 * changed and who decided it.
 */
export const DISPLAY_BLOCKED_LABEL = "Blocked";

export type DisplayResource = {
  id: string;
  name: string;
  type: ResourceType;
  sortOrder: number;
};

export type DisplaySession = {
  id: string;
  resourceId: string;
  startAt: Date;
  endAt: Date;
  /** Already resolved to a safe label — callers never see a raw name or email. */
  coachLabel: string;
  isGroupSession: boolean;
};

export type DisplayBlock = {
  id: string;
  resourceId: string;
  startAt: Date;
  endAt: Date;
  /**
   * Already resolved by `resolveDisplayBlockLabel`, the one place that turns
   * a block's raw columns into the text on its bar. For a HAND-ENTERED block
   * this is the note that was typed, trimmed; for a program-made block it is
   * never the row's `reason`. The raw `reason` and `programScheduleBlockId`
   * columns are deliberately not on this type. Mirrors `coachLabel` on
   * DisplaySession: callers get something printable, not the columns behind
   * it.
   */
  label: string;
};

export type DisplaySchedule = {
  resources: DisplayResource[];
  sessions: DisplaySession[];
  blocks: DisplayBlock[];
};

/**
 * The rows exactly as the three queries project them, before any mapping.
 *
 * 🔴 THIS IS EXPORTED SO THE PROJECTION CAN BE TESTED ON ITS OWN, AND THAT
 * SPLIT WAS FORCED BY A MUTATION SWEEP. The sentinel tests originally
 * asserted only on `fetchDisplaySchedule`'s return value — and putting
 * `note: sessionsBilling.note` back into the SELECT broke NOTHING, because
 * the mapping below rebuilds each session as an explicit object and silently
 * dropped it again. The tests were guarding the MAP while this file's header
 * claimed the PROJECTION was the boundary; two defences, one of them
 * unverified, and no way to tell which was load-bearing.
 *
 * Now both are asserted independently: key-set tests run against these raw
 * rows, sentinel tests run against the mapped result. Either one regressing
 * fails a named test.
 *
 * 🔴 THESE ROWS ARE NOT SAFE TO RENDER OR TO PASS TO A COMPONENT. Since
 * 2026-10-13 every block row carries its `reason`. `fetchDisplaySchedule` is
 * the only thing in `src/` that should read them.
 */
export type DisplayScheduleRows = {
  resources: DisplayResource[];
  sessions: {
    id: string;
    resourceId: string;
    startAt: Date;
    endAt: Date;
    coachName: string | null;
    isGroupSession: boolean;
  }[];
  blocks: {
    id: string;
    resourceId: string;
    startAt: Date;
    endAt: Date;
    // 🔴 FREE TEXT, PRESENT ON EVERY BLOCK ROW. Printed only for a
    // hand-entered one, and only as its label — see the file header.
    reason: string;
    // NULL for a hand-entered block; set when a scheduled program owns the
    // row. This link — not what `reason` looks like — is what the label rule
    // keys off.
    programScheduleBlockId: string | null;
    // Both NULL for a hand-entered block: the LEFT JOINs below find no
    // program.
    programName: string | null;
    programDisplayName: string | null;
    // Both NULL unless an admin picked a program tag on the Block form.
    tagName: string | null;
    tagDisplayName: string | null;
  }[];
};

/**
 * Everything the display needs for one rolling window.
 *
 * Resources are unfiltered by type on purpose: Mark asked for the whole
 * facility schedule — every cage, the bullpen AND the weight room — so this
 * selects every ACTIVE resource, exactly as `/master/schedule` does. There is
 * deliberately no resource filter in this feature.
 *
 * 🔴 The work-hours schedule is a DIFFERENT surface (`/admin/hour-log/schedule`,
 * built from `hour_logs` and `program_schedule_blocks`) and Mark explicitly
 * does not want it on the screen. Reading only the three tables below is what
 * keeps that true structurally rather than by remembering to.
 */
export async function fetchDisplayScheduleRows(
  win: DisplayWindow,
): Promise<DisplayScheduleRows> {
  // Half-open OVERLAP, not containment on startAt. `/master/schedule` filters
  // `startAt >= dayStart AND startAt < dayEnd`, which is fine for a whole day
  // and WRONG for a four-hour window: it drops the session that is in
  // progress right now, which is the single most important bar on the screen
  // and the entire reason for the 30-minute lookback.
  const overlapsSession = and(
    lt(sessionsBilling.startAt, win.endAt),
    gt(sessionsBilling.endAt, win.startAt),
  );
  const overlapsBlock = and(
    lt(blockedTimes.startAt, win.endAt),
    gt(blockedTimes.endAt, win.startAt),
  );

  const [resourceRows, sessionRows, blockRows] = await Promise.all([
    db
      .select({
        id: resources.id,
        name: resources.name,
        type: resources.type,
        sortOrder: resources.sortOrder,
      })
      .from(resources)
      .where(eq(resources.active, true))
      .orderBy(asc(resources.sortOrder)),

    // NOTE: no `note`. No `coachEmail`. Adding either is a PII regression,
    // and `display-schedule.test.ts` fails loudly if one reappears.
    db
      .select({
        id: sessionsBilling.id,
        resourceId: sessionsBilling.resourceId,
        startAt: sessionsBilling.startAt,
        endAt: sessionsBilling.endAt,
        coachName: users.name,
        isGroupSession: sessionsBilling.isGroupSession,
      })
      .from(sessionsBilling)
      .innerJoin(users, eq(sessionsBilling.coachId, users.id))
      .where(overlapsSession)
      .orderBy(asc(sessionsBilling.startAt)),

    // NOTE: NOT a bare `.select()`. An explicit projection is what stops the
    // next column added to `blocked_times` from landing in these rows without
    // anyone deciding it should.
    //
    // 🔴 `reason` IS IN THIS LIST ON PURPOSE — the owner's decision of
    // 2026-10-13, see the file header — and so is `programScheduleBlockId`,
    // the link that says whether a row's reason may be printed. Neither one
    // leaves this module: `resolveDisplayBlockLabel` reads both, and the
    // mapping in `fetchDisplaySchedule` exposes only the label it returns.
    //
    // 🔴 THE JOINS FETCH THE TWO NAMES THAT ARE NOT THE NOTE. Mark's wife
    // asked for the blocked bars to say what is blocking them rather than
    // just "Blocked" (2026-08-30). For a block a scheduled program owns, the
    // first two joins reach that program: `programs.name` is admin-curated
    // and unique-constrained, where the row's own `reason` is the auto text
    // `Program: <name>`. The last join fetches the program tag an admin can
    // pick on a hand-entered block. A hand-entered block's own note needs no
    // join; it is the `reason` column above.
    //
    // All three joins are LEFT, not INNER, and that is load-bearing: a
    // hand-entered block has a NULL `programScheduleBlockId`, and an INNER
    // join would drop it from the query entirely — an unavailable cage would
    // render as FREE, the exact failure the red bar was introduced to fix.
    // Proven by mutation: flipping any one of them turns tests red in
    // tests/integration/display-schedule.test.ts.
    db
      .select({
        id: blockedTimes.id,
        resourceId: blockedTimes.resourceId,
        startAt: blockedTimes.startAt,
        endAt: blockedTimes.endAt,
        reason: blockedTimes.reason,
        programScheduleBlockId: blockedTimes.programScheduleBlockId,
        programName: programs.name,
        programDisplayName: programs.displayName,
        // The hand-picked tag: a program an admin chose from a fixed list on
        // the Block form, not text anyone typed.
        tagName: taggedProgram.name,
        tagDisplayName: taggedProgram.displayName,
      })
      .from(blockedTimes)
      .leftJoin(
        programScheduleBlocks,
        eq(blockedTimes.programScheduleBlockId, programScheduleBlocks.id),
      )
      .leftJoin(programs, eq(programScheduleBlocks.programId, programs.id))
      .leftJoin(taggedProgram, eq(blockedTimes.displayProgramId, taggedProgram.id))
      .where(overlapsBlock)
      .orderBy(asc(blockedTimes.startAt)),
  ]);

  return { resources: resourceRows, sessions: sessionRows, blocks: blockRows };
}

/**
 * The zero-width characters `String.prototype.trim` leaves in place: zero
 * width space, non-joiner, joiner, and word joiner. (`trim` already strips
 * U+FEFF along with ordinary whitespace.)
 *
 * 🔴 USED ONLY TO ASK "IS THERE ANYTHING VISIBLE IN THIS NOTE?", NEVER TO
 * REWRITE ONE. A note made of nothing but these would otherwise pass the
 * blank check and print a bar with no text in it. A note that has visible
 * text is printed exactly as typed, these characters included — a zero-width
 * joiner is part of how some emoji and some scripts are written.
 */
const ZERO_WIDTH_CHARS = /[\u200B\u200C\u200D\u2060]/g;

/**
 * The text a red bar prints. The ONE place a block's raw columns become
 * something the wall shows, and the only reader of `reason` in this file.
 *
 * 🔴 THE DISCRIMINATOR IS THE LINK, NOT THE TEXT. Whether a row's `reason`
 * may be printed is decided by `programScheduleBlockId` alone — never by
 * whether the text starts with "Program:".
 *
 *   · PROGRAM-MADE (`programScheduleBlockId` set). Exactly the chain this
 *     file used before 2026-10-13: the program's short name, then its full
 *     name, then the tag, then the generic label. `reason` is never read.
 *   · HAND-ENTERED (`programScheduleBlockId` NULL). The note that was typed,
 *     trimmed at its ends, when it has anything visible in it; otherwise the
 *     tag, then the generic label. The admin forms require a note, so in
 *     practice a hand-entered block prints its note and the tag is only a
 *     fallback.
 *
 * The test is `!== null`, so a row that somehow arrives without the column
 * is treated as program-made and its reason is withheld — it fails closed.
 *
 * Pure, and it takes only the six columns it reads, so every branch is pinned
 * in display-schedule.test.ts without a database.
 */
export function resolveDisplayBlockLabel(
  row: Pick<
    DisplayScheduleRows["blocks"][number],
    | "programScheduleBlockId"
    | "reason"
    | "programName"
    | "programDisplayName"
    | "tagName"
    | "tagDisplayName"
  >,
): string {
  if (row.programScheduleBlockId !== null) {
    // Short form first, then the full program name, then the tag, then the
    // generic fallback. The `??` chain — not `||` — so a program deliberately
    // given an empty-string short name is not silently skipped over; an empty
    // label is a data problem worth seeing on the wall rather than one to
    // paper over here.
    // Order matters. REAL OCCUPANCY WINS over the cosmetic tag: if a
    // scheduled program owns the slot, that is what the slot IS, and a tag
    // someone also set cannot overrule it.
    return (
      row.programDisplayName ??
      row.programName ??
      row.tagDisplayName ??
      row.tagName ??
      DISPLAY_BLOCKED_LABEL
    );
  }

  const note = row.reason.trim();
  // Blank is decided with the zero-width characters taken out; what is
  // printed is the note itself, with nothing taken out of it.
  if (note.replace(ZERO_WIDTH_CHARS, "").trim() !== "") return note;

  return row.tagDisplayName ?? row.tagName ?? DISPLAY_BLOCKED_LABEL;
}

/**
 * What the page renders. Turns the raw rows into things that are safe to
 * print: a coach NAME becomes a coach LABEL, and a block's raw columns become
 * one LABEL. Of a raw block row, only its id, resource, times and that label
 * survive this function.
 */
export async function fetchDisplaySchedule(
  win: DisplayWindow,
): Promise<DisplaySchedule> {
  const rows = await fetchDisplayScheduleRows(win);
  return {
    resources: rows.resources,
    sessions: rows.sessions.map((r) => ({
      id: r.id,
      resourceId: r.resourceId,
      startAt: r.startAt,
      endAt: r.endAt,
      // Resolved HERE rather than in the view, so there is exactly one place
      // where a missing name is turned into something safe to print.
      coachLabel: r.coachName ?? DISPLAY_UNNAMED_COACH_LABEL,
      isGroupSession: r.isGroupSession,
    })),
    // 🔴 FIELD BY FIELD, NEVER `...r`. The raw row carries `reason` and
    // `programScheduleBlockId` for every block; spreading it would put both
    // on the result the page is handed.
    blocks: rows.blocks.map((r) => ({
      id: r.id,
      resourceId: r.resourceId,
      startAt: r.startAt,
      endAt: r.endAt,
      label: resolveDisplayBlockLabel(r),
    })),
  };
}
