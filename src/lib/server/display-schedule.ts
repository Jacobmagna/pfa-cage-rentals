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
// 🔴 THREE FIELDS MUST NEVER BE SELECTED HERE, and "not rendered" is NOT the
// same as "not sent" — a value that reaches a server component reaches the
// serialized RSC payload in the page source, whether or not any JSX prints it:
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
export async function fetchDisplaySchedule(
  win: DisplayWindow,
): Promise<DisplaySchedule> {
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

  return {
    resources: resourceRows,
    sessions: sessionRows.map((r) => ({
      id: r.id,
      resourceId: r.resourceId,
      startAt: r.startAt,
      endAt: r.endAt,
      // Resolved HERE rather than in the view, so there is exactly one place
      // where a missing name is turned into something safe to print.
      coachLabel: r.coachName ?? DISPLAY_UNNAMED_COACH_LABEL,
      isGroupSession: r.isGroupSession,
    })),
    blocks: blockRows,
  };
}
