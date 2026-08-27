// The ONLY query that feeds the public TV display.
//
// 🔴🔴 THIS MODULE IS THE PII BOUNDARY OF THE ENTIRE FEATURE. Read this
// header before changing a single select.
//
// The display page is UNAUTHENTICATED. There is no middleware in this repo —
// every other schedule surface is gated by a `requireRole` / `requireScheduleAccess`
// call inside its own server component, and this one deliberately has no such
// call. So nothing structural stops a field from reaching the public internet;
// the only thing that stops it is the projection list below.
//
// 🔴 THREE FIELDS MUST NEVER BE SELECTED HERE.
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
// 🔴 SO THE REAL HAZARD IS SHARPER AND EASIER TO TRIP OVER: today `DisplayGrid`
// is a server component, so an extra column here would be caught by the
// mapping and never shipped. THE DAY SOMEBODY ADDS `"use client"` TO IT — for
// an animation, a marquee, a ticking clock — every prop it receives becomes
// serialized, and any field riding along in this projection is published.
// That is a one-line change in a different file, made for an unrelated
// reason, by someone who will not read this comment. The projection is
// narrow so that change stays safe.
//
// The three fields, and why each one matters:
//
//   · sessionsBilling.note   — free text. `/master/schedule` puts it in a
//     `title` attribute. A tooltip is invisible on a TV (no mouse) and fully
//     readable in View Source. Nothing stops a coach typing "Tyler makeup
//     lesson" or "bday party - Jake" into it. That is a MINOR'S NAME on a
//     public page.
//   · blockedTimes.reason    — same class, same risk.
//   · users.email            — a coach's personal email on a wall screen and
//     in a public page source.
//
// ⚠️ AND THE TRAP THAT IS ALREADY IN THE CODEBASE: `/master/schedule`'s
// blockedTimes query is a BARE `db.select().from(blockedTimes)` with no
// projection — it ships every column on that table, including `reason`, and
// silently gains any column added to it later. Copying that query shape into
// this file would reintroduce the leak in the one place it actually matters.
// Every select here is explicit for that reason. Keep them explicit.
//
// The token in the URL is the SECOND layer, not the first (src/lib/display/token.ts).
// If the URL leaks, this projection is what decides whether the leak is
// "cages, times and coach names" — which is what is already visible on a
// screen in a room the public walks through — or something worse.

import { and, asc, eq, gt, lt } from "drizzle-orm";
import { db } from "@/db";
import { blockedTimes, resources, sessionsBilling, users } from "@/db/schema";
import type { ResourceType } from "@/lib/billing";
import type { DisplayWindow } from "@/lib/display/window";

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
  blocks: DisplayBlock[];
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

    // NOTE: no `reason`, and NOT a bare `.select()`. An explicit projection
    // is what stops the next column added to `blocked_times` from landing on
    // a public page without anyone deciding it should.
    db
      .select({
        id: blockedTimes.id,
        resourceId: blockedTimes.resourceId,
        startAt: blockedTimes.startAt,
        endAt: blockedTimes.endAt,
      })
      .from(blockedTimes)
      .where(overlapsBlock)
      .orderBy(asc(blockedTimes.startAt)),
  ]);

  return { resources: resourceRows, sessions: sessionRows, blocks: blockRows };
}

/**
 * What the page renders. Adds exactly one thing to the raw rows: a coach
 * NAME becomes a coach LABEL that is always safe to print.
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
    blocks: rows.blocks,
  };
}
