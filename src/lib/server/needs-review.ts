// QA10 W3-polish15b: server-only derivation of the admin "needs review"
// block-accountability queue. Two kinds of alert:
//
//   • cancelled — a coach actively cancelled their assignment to a
//     scheduled program block (a program_block_coach_flags row with
//     kind='cancelled' that no admin has resolved yet, i.e. reviewedAt is
//     NULL). These are stored, so we just fetch the open ones.
//
//   • no_show — DERIVED (no stored row): a scheduled block that ENDED more
//     than 1 hr ago, where a coach who is a MEMBER of the block has NO
//     matching hour-log (same program, overlapping time), AND there is no
//     existing flag for that (block, coach) — neither a 'cancelled' (the
//     coach told us in advance) nor a 'no_show' (an admin already
//     acknowledged it). Acknowledging a no-show inserts a stored 'no_show'
//     flag, which is why an already-acknowledged one drops off here.
//
// Everything is bounded to a 30-day lookback window so the derivation stays
// cheap and the queue never grows without bound.

import { and, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import { db } from "@/db";
import {
  hourLogs,
  programBlockCoachFlags,
  programScheduleBlockCoaches,
  programScheduleBlocks,
  programs,
  users,
} from "@/db/schema";
import { isLogScheduled } from "@/lib/coach-hour-log";

export type CancelledAlert = {
  type: "cancelled";
  flagId: string;
  coachName: string | null;
  programName: string;
  startAt: Date;
  endAt: Date;
  note: string | null;
};

export type NoShowAlert = {
  type: "no_show";
  blockId: string;
  coachId: string;
  coachName: string | null;
  programName: string;
  startAt: Date;
  endAt: Date;
};

const LOOKBACK_MS = 30 * 24 * 60 * 60_000;
const GRACE_MS = 60 * 60_000;

export async function fetchBlockAccountabilityAlerts(
  now: Date,
): Promise<{ cancelled: CancelledAlert[]; noShow: NoShowAlert[] }> {
  const windowStart = new Date(now.getTime() - LOOKBACK_MS);
  const noShowCutoff = new Date(now.getTime() - GRACE_MS);

  // --- cancelled: stored, unresolved 'cancelled' flags ---
  const cancelledRows = await db
    .select({
      flagId: programBlockCoachFlags.id,
      note: programBlockCoachFlags.note,
      startAt: programScheduleBlocks.startAt,
      endAt: programScheduleBlocks.endAt,
      programName: programs.name,
      coachName: users.name,
      coachEmail: users.email,
    })
    .from(programBlockCoachFlags)
    .innerJoin(
      programScheduleBlocks,
      eq(programScheduleBlocks.id, programBlockCoachFlags.blockId),
    )
    .innerJoin(programs, eq(programs.id, programScheduleBlocks.programId))
    .innerJoin(users, eq(users.id, programBlockCoachFlags.coachId))
    .where(
      and(
        eq(programBlockCoachFlags.kind, "cancelled"),
        isNull(programBlockCoachFlags.reviewedAt),
      ),
    );

  const cancelled: CancelledAlert[] = cancelledRows.map((r) => ({
    type: "cancelled",
    flagId: r.flagId,
    coachName: r.coachName ?? r.coachEmail,
    programName: r.programName,
    startAt: r.startAt,
    endAt: r.endAt,
    note: r.note,
  }));

  // --- no_show: derived ---
  // 1. candidate (block, coach) pairs: blocks that ended >1h ago, within
  //    the lookback window, for every member coach.
  const candidates = await db
    .select({
      blockId: programScheduleBlocks.id,
      programId: programScheduleBlocks.programId,
      programName: programs.name,
      coachId: programScheduleBlockCoaches.coachId,
      coachName: users.name,
      coachEmail: users.email,
      startAt: programScheduleBlocks.startAt,
      endAt: programScheduleBlocks.endAt,
    })
    .from(programScheduleBlocks)
    .innerJoin(
      programScheduleBlockCoaches,
      eq(programScheduleBlockCoaches.blockId, programScheduleBlocks.id),
    )
    .innerJoin(programs, eq(programs.id, programScheduleBlocks.programId))
    .innerJoin(users, eq(users.id, programScheduleBlockCoaches.coachId))
    .where(
      and(
        gte(programScheduleBlocks.endAt, windowStart),
        lt(programScheduleBlocks.endAt, noShowCutoff),
      ),
    );

  if (candidates.length === 0) {
    return { cancelled, noShow: [] };
  }

  const coachIds = [...new Set(candidates.map((c) => c.coachId))];
  const blockIds = [...new Set(candidates.map((c) => c.blockId))];

  // 2. logs for these coaches within the window, grouped by coach.
  const logRows = await db
    .select({
      coachId: hourLogs.coachId,
      programId: hourLogs.programId,
      startAt: hourLogs.startAt,
      endAt: hourLogs.endAt,
    })
    .from(hourLogs)
    .where(
      and(
        inArray(hourLogs.coachId, coachIds),
        gte(hourLogs.startAt, windowStart),
      ),
    );

  const logsByCoach = new Map<
    string,
    { programId: string; startMs: number; endMs: number }[]
  >();
  for (const log of logRows) {
    const list = logsByCoach.get(log.coachId) ?? [];
    list.push({
      programId: log.programId,
      startMs: log.startAt.getTime(),
      endMs: log.endAt.getTime(),
    });
    logsByCoach.set(log.coachId, list);
  }

  // 3. existing flags for these blocks — both kinds suppress a no-show.
  const flagRows = await db
    .select({
      blockId: programBlockCoachFlags.blockId,
      coachId: programBlockCoachFlags.coachId,
      kind: programBlockCoachFlags.kind,
    })
    .from(programBlockCoachFlags)
    .where(inArray(programBlockCoachFlags.blockId, blockIds));

  const cancelledKeys = new Set<string>();
  const noShowKeys = new Set<string>();
  for (const f of flagRows) {
    const key = `${f.blockId}:${f.coachId}`;
    if (f.kind === "cancelled") cancelledKeys.add(key);
    else if (f.kind === "no_show") noShowKeys.add(key);
  }

  const noShow: NoShowAlert[] = [];
  for (const c of candidates) {
    const key = `${c.blockId}:${c.coachId}`;
    if (cancelledKeys.has(key) || noShowKeys.has(key)) continue;
    const scheduled = isLogScheduled(
      {
        programId: c.programId,
        startMs: c.startAt.getTime(),
        endMs: c.endAt.getTime(),
      },
      logsByCoach.get(c.coachId) ?? [],
    );
    if (scheduled) continue;
    noShow.push({
      type: "no_show",
      blockId: c.blockId,
      coachId: c.coachId,
      coachName: c.coachName ?? c.coachEmail,
      programName: c.programName,
      startAt: c.startAt,
      endAt: c.endAt,
    });
  }

  return { cancelled, noShow };
}
