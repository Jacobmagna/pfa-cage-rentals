// QA10 W3.3: shared internal helpers for "a scheduled program occupies a
// cage resource". When an admin ticks a resource on a program block (or a
// recurring series occurrence), we write a NORMAL `blocked_times` row LINKED
// to that program block via blocked_times.program_schedule_block_id. Reusing
// blocked_times means the occupancy automatically (a) shows on both calendars
// by `reason`, and (b) blocks coach cage booking (session-actions.ts already
// rejects sessions overlapping a blocked_time — untouched).
//
// neon-http has NO transactions, so the action layer PRE-VALIDATES every
// resource/time against existing sessions + blocks BEFORE writing anything
// (mirrors createSessionsBatchInternal). These helpers are the building
// blocks of that pre-validate-then-insert pipeline. Both the single-block
// and the series action files import them so the conflict logic lives in one
// place (do not export session-actions/block-actions' private finders).

import { and, eq, gt, isNull, lt, ne, notInArray, or } from "drizzle-orm";
import { db } from "@/db";
import {
  blockedTimes,
  programScheduleBlocks,
  resources,
  sessionsBilling,
  users,
} from "@/db/schema";
import {
  BlockConflictsWithSessionError,
  BlockOverlapError,
  ResourceNotFoundError,
} from "@/lib/errors";

// Postgres SQLSTATE 23P01 — exclusion-constraint violation, thrown by the
// `blocked_times_no_overlap` EXCLUDE constraint when a linked occupancy row
// races onto a slot that became busy AFTER assertResourcesFree pre-checked
// it. Mirrors the private helper in session-actions.ts (kept separate per the
// "do not export session-actions' private finders" rule); Neon's HTTP driver
// wraps DB errors, so we walk the cause chain. Exported so the program-block /
// series action files can translate this collision into a friendly
// BlockOverlapError instead of a raw 500 (and run their compensating writes).
export function isExclusionViolation(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err && err.code === "23P01") {
    return true;
  }
  if (err instanceof Error && err.cause) {
    return isExclusionViolation(err.cause);
  }
  return false;
}

// Overlap query: two ranges [a, b) and [c, d) overlap iff a < d and b > c.
// Mirrors the EXCLUDE constraint's tsrange semantics — back-to-back
// (end == next start) does NOT overlap.
async function findOverlappingSession(
  resourceId: string,
  startAt: Date,
  endAt: Date,
) {
  const [row] = await db
    .select({
      id: sessionsBilling.id,
      startAt: sessionsBilling.startAt,
      endAt: sessionsBilling.endAt,
      coachName: users.name,
      coachEmail: users.email,
    })
    .from(sessionsBilling)
    .innerJoin(users, eq(sessionsBilling.coachId, users.id))
    .where(
      and(
        eq(sessionsBilling.resourceId, resourceId),
        lt(sessionsBilling.startAt, endAt),
        gt(sessionsBilling.endAt, startAt),
      ),
    )
    .limit(1);
  return row;
}

// Overlapping existing block on the same resource. `opts.excludeProgramBlockId`
// skips blocked_times linked to THAT program block, so re-saving the same
// program block (same resources, same/changed time) doesn't self-conflict.
// `opts.excludeSeriesId` skips blocked_times linked to ANY block of that
// series — used when an edit-series regenerate pre-validates BEFORE deleting
// the series' own future occupancy. Both exclusions are NULL-safe: a
// manually-created blocked_time (NULL link) is ALWAYS still checked, so an
// admin editing onto a hand-blocked slot gets the friendly conflict error
// instead of the raw EXCLUDE-constraint crash.
async function findOverlappingBlock(
  resourceId: string,
  startAt: Date,
  endAt: Date,
  opts?: { excludeProgramBlockId?: string; excludeSeriesId?: string },
) {
  const conditions = [
    eq(blockedTimes.resourceId, resourceId),
    lt(blockedTimes.startAt, endAt),
    gt(blockedTimes.endAt, startAt),
  ];
  if (opts?.excludeProgramBlockId) {
    conditions.push(
      or(
        isNull(blockedTimes.programScheduleBlockId),
        ne(blockedTimes.programScheduleBlockId, opts.excludeProgramBlockId),
      )!,
    );
  }
  if (opts?.excludeSeriesId) {
    const seriesBlockIds = db
      .select({ id: programScheduleBlocks.id })
      .from(programScheduleBlocks)
      .where(eq(programScheduleBlocks.seriesId, opts.excludeSeriesId));
    conditions.push(
      or(
        isNull(blockedTimes.programScheduleBlockId),
        notInArray(blockedTimes.programScheduleBlockId, seriesBlockIds),
      )!,
    );
  }
  const [row] = await db
    .select()
    .from(blockedTimes)
    .where(and(...conditions))
    .limit(1);
  return row;
}

// Resolve resource names so a conflict error names the actual cage. Returns
// a Map<resourceId, name>; throws ResourceNotFoundError if any id is unknown.
export async function resolveResourceNames(
  resourceIds: string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(resourceIds)];
  if (ids.length === 0) return new Map();
  const rows = await db.select().from(resources);
  const byId = new Map(rows.map((r) => [r.id, r.name]));
  const names = new Map<string, string>();
  for (const id of ids) {
    const name = byId.get(id);
    if (!name) throw new ResourceNotFoundError(id);
    names.set(id, name);
  }
  return names;
}

// Pre-validate that each resource is free over [startAt, endAt). Throws
// BlockConflictsWithSessionError on a busy session, BlockOverlapError on an
// existing block. `opts.excludeProgramBlockId` ignores the program block's
// OWN linked blocked_times (for edits); `opts.excludeSeriesId` ignores the
// whole series' linked blocked_times (for edit-series regenerate). NOTE:
// neon-http has no transactions, so callers MUST call this BEFORE writing
// the program block + its blocks.
export async function assertResourcesFree(
  resourceIds: string[],
  startAt: Date,
  endAt: Date,
  opts?: { excludeProgramBlockId?: string; excludeSeriesId?: string },
): Promise<void> {
  const ids = [...new Set(resourceIds)];
  if (ids.length === 0) return;
  const names = await resolveResourceNames(ids);
  for (const resourceId of ids) {
    const resourceName = names.get(resourceId) ?? resourceId;

    const session = await findOverlappingSession(resourceId, startAt, endAt);
    if (session) {
      throw new BlockConflictsWithSessionError(
        resourceName,
        session.coachName ?? session.coachEmail,
        session.startAt,
        session.endAt,
      );
    }

    const block = await findOverlappingBlock(resourceId, startAt, endAt, opts);
    if (block) {
      throw new BlockOverlapError(
        resourceName,
        block.reason,
        block.startAt,
        block.endAt,
      );
    }
  }
}

export type ProgramResourceBlockRow = {
  programScheduleBlockId: string;
  resourceId: string;
  startAt: Date;
  endAt: Date;
  reason: string;
  createdBy: string;
};

// Bulk-insert linked blocked_times in a single statement. No-op when empty.
//
// assertResourcesFree pre-checks every slot, but it is read-then-write and
// neon-http has no transactions, so a concurrent booking can grab a slot in
// the race window and this INSERT trips the `blocked_times_no_overlap` EXCLUDE
// constraint (SQLSTATE 23P01). When that happens we re-query the colliding
// block to name it and throw a friendly BlockOverlapError — the SAME error the
// pre-check throws — so callers' catch sites and the UI handle it uniformly
// instead of a raw 500. Any non-23P01 error rethrows untranslated.
//
// IMPORTANT (no transactions): a 23P01 here means the bulk INSERT was rejected
// in full by Postgres (single statement = all-or-nothing), so no occupancy row
// was written. The caller is still responsible for compensating any rows it
// wrote in EARLIER statements (e.g. the program block + coach rows).
export async function insertProgramResourceBlocks(
  rows: ProgramResourceBlockRow[],
): Promise<void> {
  if (rows.length === 0) return;
  try {
    await db.insert(blockedTimes).values(
      rows.map((r) => ({
        resourceId: r.resourceId,
        startAt: r.startAt,
        endAt: r.endAt,
        reason: r.reason,
        programScheduleBlockId: r.programScheduleBlockId,
        createdBy: r.createdBy,
      })),
    );
  } catch (err) {
    if (!isExclusionViolation(err)) throw err;
    // Find which row collided so the message names the real cage + reason.
    // Exclude this block's own (just-attempted) rows is unnecessary — none
    // were committed — so a plain overlap query identifies the foreign block.
    const names = await resolveResourceNames(rows.map((r) => r.resourceId));
    for (const r of rows) {
      const conflict = await findOverlappingBlock(
        r.resourceId,
        r.startAt,
        r.endAt,
      );
      if (conflict) {
        throw new BlockOverlapError(
          names.get(r.resourceId) ?? r.resourceId,
          conflict.reason,
          conflict.startAt,
          conflict.endAt,
        );
      }
    }
    // 23P01 but no overlap found on re-query (e.g. the racing row was already
    // removed). Surface a generic-but-friendly overlap on the first row rather
    // than a raw 500.
    const first = rows[0];
    throw new BlockOverlapError(
      names.get(first.resourceId) ?? first.resourceId,
      first.reason,
      first.startAt,
      first.endAt,
    );
  }
}

// The reason text stamped on a program-occupancy blocked_time.
export function programOccupancyReason(programName: string): string {
  return `Program: ${programName}`;
}
