// BLOCK-RECUR: internal mutation logic for RECURRING blocked-time series —
// the cage-rental analog of program-schedule-series-actions.ts. Lives outside
// any "use server" file (same reason: these take the actor as a parameter, so
// exposing them as RPC would let a caller forge an identity). Public
// requireScheduleAccess()-gated wrappers live in
// src/app/admin/schedule/actions.ts.
//
// A series is a weekly/monthly recurrence on ONE resource with a free-text
// reason. We MATERIALIZE one blocked_times row per occurrence (seriesId links
// back), so the schedule grid keeps reading blocked_times unchanged. Unlike
// program series there are no coaches and no separate occupancy table — a
// blocked_times row IS the block.
//
// CONFLICT POLICY (locked with Jacob): SKIP-AND-CONTINUE, not all-or-nothing.
//   • occurrence overlaps an existing RENTAL  → skip it, REPORT it (the admin
//     needs to know a paid rental sits in their window).
//   • occurrence overlaps an existing BLOCK   → skip it silently (already
//     blocked — redundant; also avoids the blocked_times EXCLUDE constraint).
//   • invalid pattern / > MAX_OCCURRENCES     → hard reject (thrown by the
//     pure generator before any DB write).
// The action returns a summary (created count + the skipped-rental report) so
// the UI can show "Blocked 24 of 26 — 2 skipped (already rented)".
//
// neon-http has NO transactions, so mutations are sequential; safeLogAudit
// swallows + Sentry-captures audit failures so a logging hiccup never loses a
// mutation. The edit path uses a snapshot/restore saga (mirrors the program
// series edit) so a mid-regenerate failure restores the prior future blocks.

import { and, eq, gt, gte, inArray, lt } from "drizzle-orm";
import * as Sentry from "@sentry/nextjs";
import { db } from "@/db";
import {
  blockedTimes,
  blockedTimesSeries,
  resources,
  sessionsBilling,
  users,
} from "@/db/schema";
import type { AuthedSession } from "@/lib/authz";
import {
  BlockedTimeSeriesNotFoundError,
  BlockNotFoundError,
  NotASeriesOccurrenceError,
  ResourceNotFoundError,
} from "@/lib/errors";
import {
  createBlocksBatchSchema,
  createBlockSeriesSchema,
  editBlockSeriesSchema,
} from "@/lib/schemas/block";
import { generateOccurrences, type Occurrence } from "@/lib/schedule-recurrence";
import { formatPfaDate, formatPfaTime12h } from "@/lib/timezone";
import { safeLogAudit } from "./audit-helpers";

const AUDIT_ENTITY = "blocked_times_series";

type Actor = AuthedSession["user"];

// Postgres EXCLUDE-constraint violation (blocked_times_no_overlap). Mirrors
// isExclusionViolation in block-actions.ts. A recurring insert pre-filters
// conflicts, so this only fires on a concurrent booking/block landing in the
// TOCTOU gap — we translate it to a friendly retry message instead of a raw
// 23P01 reaching the admin.
function isExclusionViolation(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err && err.code === "23P01") {
    return true;
  }
  if (err instanceof Error && err.cause) {
    return isExclusionViolation(err.cause);
  }
  return false;
}

class BlockSlotTakenError extends Error {
  readonly code = "BLOCK_SLOT_TAKEN" as const;
  constructor(resourceName: string) {
    super(
      `${resourceName} was just booked or blocked while saving this recurring block. Reopen and try again — the conflicting slot will be skipped.`,
    );
    this.name = "BlockSlotTakenError";
  }
}

// A rental occurrence we skipped, surfaced to the admin so they can follow up.
// MULTI-CAGE: resourceName names the specific cage the collision was on so the
// report reads e.g. "Aug 3 · 3:00 – 5:00 PM · Cage 2 · Coach Smith".
export type SkippedRental = {
  date: string; // PFA "YYYY-MM-DD"
  resourceName: string;
  coachName: string;
  label: string;
};

// Shared result shape for a skip-and-continue block mutation (batch one-off or
// recurring series). `created` counts materialized blocked_times ROWS across
// ALL resources (cages × surviving dates), not distinct dates.
export type BlockBatchResult = {
  created: number;
  skippedRentals: SkippedRental[];
  skippedBlocked: number; // (resource, date) pairs already blocked (silent skip)
};

export type BlockSeriesResult = BlockBatchResult & {
  seriesId: string | null; // null when nothing could be blocked (no series made)
};

// Half-open [start, end) overlap — matches the blocked_times / sessions_billing
// tsrange EXCLUDE constraints (adjacent intervals that merely touch don't
// overlap).
function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() < bEnd.getTime() && aEnd.getTime() > bStart.getTime();
}

// MULTI-CAGE: de-dupe (preserving order) + validate that EVERY resource id
// exists, returning a Map<id, name> for the conflict report. Throws
// ResourceNotFoundError naming the first missing id — matches the single-cage
// path's behavior. The deduped id order is the caller's responsibility to
// reuse (resourceIds[0] becomes the series' denormalized primary).
async function resolveResourceNamesOrThrow(
  resourceIds: string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(resourceIds)];
  const rows = ids.length
    ? await db.select().from(resources).where(inArray(resources.id, ids))
    : [];
  const byId = new Map(rows.map((r) => [r.id, r.name]));
  for (const id of ids) {
    if (!byId.has(id)) throw new ResourceNotFoundError(id);
  }
  return byId;
}

// Classify each occurrence against what's already on the resource in the
// occurrences' time window, applying the skip-and-continue policy. One
// range-scan of sessions + blocks (not a query per occurrence) keeps this
// cheap even at the 366-occurrence cap. `excludeSeriesId` drops that series'
// OWN blocks from the "already blocked" set (used on edit, where the series'
// future blocks are being regenerated).
async function partitionOccurrences(
  resourceId: string,
  resourceName: string,
  occurrences: Occurrence[],
): Promise<{
  toInsert: Occurrence[];
  skippedRentals: SkippedRental[];
  skippedBlocked: number;
}> {
  if (occurrences.length === 0) {
    return { toInsert: [], skippedRentals: [], skippedBlocked: 0 };
  }
  const windowStart = new Date(
    Math.min(...occurrences.map((o) => o.startAt.getTime())),
  );
  const windowEnd = new Date(
    Math.max(...occurrences.map((o) => o.endAt.getTime())),
  );

  // Existing rentals on this resource in the window (with coach for the report).
  const sessionRows = await db
    .select({
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
        lt(sessionsBilling.startAt, windowEnd),
        gt(sessionsBilling.endAt, windowStart),
      ),
    );

  // Existing blocks on this resource in the window (any series / one-off /
  // program occupancy). These are skipped silently.
  const blockRows = await db
    .select({
      startAt: blockedTimes.startAt,
      endAt: blockedTimes.endAt,
    })
    .from(blockedTimes)
    .where(
      and(
        eq(blockedTimes.resourceId, resourceId),
        lt(blockedTimes.startAt, windowEnd),
        gt(blockedTimes.endAt, windowStart),
      ),
    );

  const toInsert: Occurrence[] = [];
  const skippedRentals: SkippedRental[] = [];
  let skippedBlocked = 0;

  for (const o of occurrences) {
    const rental = sessionRows.find((s) =>
      overlaps(o.startAt, o.endAt, s.startAt, s.endAt),
    );
    if (rental) {
      const coachName = rental.coachName ?? rental.coachEmail;
      skippedRentals.push({
        date: formatPfaDate(o.startAt),
        resourceName,
        coachName,
        label: `${formatPfaDate(o.startAt)} · ${formatPfaTime12h(
          o.startAt,
        )} – ${formatPfaTime12h(o.endAt)} · ${resourceName} · ${coachName}`,
      });
      continue;
    }
    const blocked = blockRows.find((b) =>
      overlaps(o.startAt, o.endAt, b.startAt, b.endAt),
    );
    if (blocked) {
      skippedBlocked += 1;
      continue;
    }
    toInsert.push(o);
  }

  return { toInsert, skippedRentals, skippedBlocked };
}

export async function createBlockSeriesInternal(
  actor: Actor,
  input: unknown,
): Promise<BlockSeriesResult> {
  const parsed = createBlockSeriesSchema.parse(input);
  // MULTI-CAGE: de-dupe (preserving first-seen order) + validate every cage.
  const resourceIds = [...new Set(parsed.resourceIds)];
  const nameById = await resolveResourceNamesOrThrow(resourceIds);

  // Generate FIRST so an invalid recurrence (over-cap, etc.) throws before we
  // write anything. Dates are cage-independent — generate once, then partition
  // per cage.
  const occurrences = generateOccurrences({
    daysOfWeek: parsed.daysOfWeek,
    startTime: parsed.startTime,
    endTime: parsed.endTime,
    startsOn: parsed.startsOn,
    endsOn: parsed.endsOn,
    frequency: parsed.frequency,
    interval: parsed.interval,
  });

  // Partition per cage; a row is one (cage, surviving date) pair. Skip-and-
  // continue is applied INDEPENDENTLY per cage, so Cage 1 can be fully blocked
  // while Cage 2 skips the two dates it's already rented.
  const rows: { resourceId: string; startAt: Date; endAt: Date }[] = [];
  const skippedRentals: SkippedRental[] = [];
  let skippedBlocked = 0;
  for (const rid of resourceIds) {
    const part = await partitionOccurrences(rid, nameById.get(rid)!, occurrences);
    for (const o of part.toInsert) {
      rows.push({ resourceId: rid, startAt: o.startAt, endAt: o.endAt });
    }
    skippedRentals.push(...part.skippedRentals);
    skippedBlocked += part.skippedBlocked;
  }

  // Nothing bookable on any cage → don't create an empty series; hand back the
  // report so the UI can say "couldn't block any — all already rented/blocked".
  if (rows.length === 0) {
    return { seriesId: null, created: 0, skippedRentals, skippedBlocked };
  }

  const [series] = await db
    .insert(blockedTimesSeries)
    .values({
      resourceId: resourceIds[0], // denormalized primary (back-compat)
      resourceIds,
      reason: parsed.reason,
      daysOfWeek: parsed.daysOfWeek,
      frequency: parsed.frequency,
      interval: parsed.interval,
      startTime: parsed.startTime,
      endTime: parsed.endTime,
      startsOn: parsed.startsOn,
      endsOn: parsed.endsOn,
      createdBy: actor.id,
    })
    .returning();

  // neon-http has no transactions: if the occurrence insert fails (e.g. a
  // concurrent booking trips the EXCLUDE constraint in the gap after the
  // conflict scan), delete the just-created series row so we never leave an
  // orphan empty series, then rethrow for the caller/UI.
  try {
    await db.insert(blockedTimes).values(
      rows.map((r) => ({
        resourceId: r.resourceId,
        startAt: r.startAt,
        endAt: r.endAt,
        reason: parsed.reason,
        seriesId: series.id,
        createdBy: actor.id,
      })),
    );
  } catch (insertErr) {
    try {
      await db
        .delete(blockedTimesSeries)
        .where(eq(blockedTimesSeries.id, series.id));
    } catch (cleanupErr) {
      // The orphan-series cleanup failed — surface it so ops can remove the
      // empty series row; we still throw the original error to the admin.
      Sentry.captureException(cleanupErr, {
        tags: { component: "block-series", op: "create-cleanup" },
        extra: { seriesId: series.id },
      });
    }
    if (isExclusionViolation(insertErr)) {
      throw new BlockSlotTakenError(nameById.get(resourceIds[0]) ?? "Resource");
    }
    throw insertErr;
  }

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: AUDIT_ENTITY,
    entityId: series.id,
    action: "create",
    after: {
      ...(series as unknown as Record<string, unknown>),
      occurrenceCount: rows.length,
      resourceCount: resourceIds.length,
      skippedRentalCount: skippedRentals.length,
      skippedBlockedCount: skippedBlocked,
    },
  });

  return {
    seriesId: series.id,
    created: rows.length,
    skippedRentals,
    skippedBlocked,
  };
}

// MULTI-CAGE: a ONE-OFF (non-recurring) block over one OR MANY resources in a
// single action, with the SAME skip-and-continue policy as the series path
// (skip a cage that's already rented/blocked at this exact time, report the
// rentals). Returns a batch summary (no series row). For a single resource
// this is equivalent to createBlockInternal but with the skip-and-continue
// report instead of a hard overlap error — the multi-cage create dialog routes
// every ≥2-cage one-off (and each independent one-off sub-form) through here.
export async function createBlocksBatchInternal(
  actor: Actor,
  input: unknown,
): Promise<BlockBatchResult> {
  const parsed = createBlocksBatchSchema.parse(input);
  if (parsed.startAt.getTime() >= parsed.endAt.getTime()) {
    throw new Error("Block start must be before end");
  }
  const resourceIds = [...new Set(parsed.resourceIds)];
  const nameById = await resolveResourceNamesOrThrow(resourceIds);

  // A one-off block is a single "occurrence" spanning [startAt, endAt).
  const occ: Occurrence = {
    date: formatPfaDate(parsed.startAt),
    startAt: parsed.startAt,
    endAt: parsed.endAt,
  };

  const rows: { resourceId: string; startAt: Date; endAt: Date }[] = [];
  const skippedRentals: SkippedRental[] = [];
  let skippedBlocked = 0;
  for (const rid of resourceIds) {
    const part = await partitionOccurrences(rid, nameById.get(rid)!, [occ]);
    for (const o of part.toInsert) {
      rows.push({ resourceId: rid, startAt: o.startAt, endAt: o.endAt });
    }
    skippedRentals.push(...part.skippedRentals);
    skippedBlocked += part.skippedBlocked;
  }

  if (rows.length === 0) {
    return { created: 0, skippedRentals, skippedBlocked };
  }

  let inserted: (typeof blockedTimes.$inferSelect)[];
  try {
    inserted = await db
      .insert(blockedTimes)
      .values(
        rows.map((r) => ({
          resourceId: r.resourceId,
          startAt: r.startAt,
          endAt: r.endAt,
          reason: parsed.reason,
          createdBy: actor.id,
        })),
      )
      .returning();
  } catch (insertErr) {
    if (isExclusionViolation(insertErr)) {
      throw new BlockSlotTakenError(nameById.get(resourceIds[0]) ?? "Resource");
    }
    throw insertErr;
  }

  // Audit each inserted block individually (mirrors createBlockInternal's
  // per-block "block" entity, so single + batch one-offs share an audit shape).
  for (const b of inserted) {
    await safeLogAudit(db, {
      actorUserId: actor.id,
      entityType: "block",
      entityId: b.id,
      action: "create",
      after: b as unknown as Record<string, unknown>,
    });
  }

  return { created: inserted.length, skippedRentals, skippedBlocked };
}

export async function editBlockSeriesInternal(
  actor: Actor,
  seriesId: string,
  input: unknown,
): Promise<BlockSeriesResult> {
  const [existing] = await db
    .select()
    .from(blockedTimesSeries)
    .where(eq(blockedTimesSeries.id, seriesId))
    .limit(1);
  if (!existing) throw new BlockedTimeSeriesNotFoundError(seriesId);

  const parsed = editBlockSeriesSchema.parse(input);
  // MULTI-CAGE: the edit may change the cage SET (add/remove cages). Validate
  // the new set; the regenerate below deletes ALL of this series' future blocks
  // (every cage) and recreates them for the new set.
  const resourceIds = [...new Set(parsed.resourceIds)];
  const nameById = await resolveResourceNamesOrThrow(resourceIds);

  // Regenerate FUTURE occurrences only; past/in-progress blocks stay as a
  // historical record. Carry the existing skipDates so a cancelled occurrence
  // isn't resurrected. The past/future split is `now`.
  const now = new Date();
  const allOccurrences = generateOccurrences({
    daysOfWeek: parsed.daysOfWeek,
    startTime: parsed.startTime,
    endTime: parsed.endTime,
    startsOn: parsed.startsOn,
    endsOn: parsed.endsOn,
    frequency: parsed.frequency,
    interval: parsed.interval,
    skipDates: existing.skipDates,
  });
  const futureOccurrences = allOccurrences.filter((o) => o.startAt >= now);

  // DATA-LOSS GUARD (no transactions): snapshot this series' FUTURE blocks
  // before deleting, so a mid-regenerate failure can restore them verbatim.
  const futureBlocks = await db
    .select()
    .from(blockedTimes)
    .where(
      and(
        eq(blockedTimes.seriesId, seriesId),
        gte(blockedTimes.startAt, now),
      ),
    );

  let result: BlockSeriesResult;
  try {
    // Free this series' future slots first, so its own occurrences don't
    // count as conflicts when we re-partition.
    await db
      .delete(blockedTimes)
      .where(
        and(
          eq(blockedTimes.seriesId, seriesId),
          gte(blockedTimes.startAt, now),
        ),
      );

    // Partition the future occurrences per cage (skip-and-continue per cage),
    // building one row per (cage, surviving date).
    const rows: { resourceId: string; startAt: Date; endAt: Date }[] = [];
    const skippedRentals: SkippedRental[] = [];
    let skippedBlocked = 0;
    for (const rid of resourceIds) {
      const part = await partitionOccurrences(
        rid,
        nameById.get(rid)!,
        futureOccurrences,
      );
      for (const o of part.toInsert) {
        rows.push({ resourceId: rid, startAt: o.startAt, endAt: o.endAt });
      }
      skippedRentals.push(...part.skippedRentals);
      skippedBlocked += part.skippedBlocked;
    }

    if (rows.length > 0) {
      await db.insert(blockedTimes).values(
        rows.map((r) => ({
          resourceId: r.resourceId,
          startAt: r.startAt,
          endAt: r.endAt,
          reason: parsed.reason,
          seriesId,
          createdBy: actor.id,
        })),
      );
    }
    result = {
      seriesId,
      created: rows.length,
      skippedRentals,
      skippedBlocked,
    };
  } catch (regenErr) {
    // Clear any partial regenerate output for this series' future window, then
    // restore the snapshot. Both best-effort; rethrow a clear error.
    try {
      await db
        .delete(blockedTimes)
        .where(
          and(
            eq(blockedTimes.seriesId, seriesId),
            gte(blockedTimes.startAt, now),
          ),
        );
    } catch (cleanupErr) {
      // Cleanup of partial regenerate output failed — capture so the restore
      // collision (if any) is diagnosable, then still attempt the restore.
      Sentry.captureException(cleanupErr, {
        tags: { component: "block-series", op: "edit-cleanup" },
        extra: { seriesId },
      });
    }
    if (futureBlocks.length > 0) {
      try {
        await db.insert(blockedTimes).values(futureBlocks);
      } catch (restoreErr) {
        // Restore FAILED — the future schedule may now be gone. This is the
        // silent-data-loss path; capture loudly so ops can recover manually.
        Sentry.captureException(restoreErr, {
          tags: { component: "block-series", op: "edit-restore-failed" },
          extra: { seriesId, lostBlockCount: futureBlocks.length },
        });
      }
    }
    if (isExclusionViolation(regenErr)) {
      throw new BlockSlotTakenError(nameById.get(resourceIds[0]) ?? "Resource");
    }
    throw new Error(
      "Failed to update the recurring block; the original schedule was " +
        "restored. Please try again.",
      { cause: regenErr },
    );
  }

  // Update the series definition only after a successful regenerate, so a
  // failure above leaves the series row (and restored blocks) at prior state.
  const [updated] = await db
    .update(blockedTimesSeries)
    .set({
      resourceId: resourceIds[0], // denormalized primary (back-compat)
      resourceIds,
      reason: parsed.reason,
      daysOfWeek: parsed.daysOfWeek,
      frequency: parsed.frequency,
      interval: parsed.interval,
      startTime: parsed.startTime,
      endTime: parsed.endTime,
      startsOn: parsed.startsOn,
      endsOn: parsed.endsOn,
    })
    .where(eq(blockedTimesSeries.id, seriesId))
    .returning();

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: AUDIT_ENTITY,
    entityId: seriesId,
    action: "update",
    before: existing as unknown as Record<string, unknown>,
    after: {
      ...(updated as unknown as Record<string, unknown>),
      regeneratedFutureCount: result.created,
      skippedRentalCount: result.skippedRentals.length,
    },
  });

  return result;
}

// Delete an ENTIRE recurring block series — the series row + every
// materialized occurrence (past and future) via the seriesId FK cascade.
// blocked_times have no downstream dependents (unlike program blocks), so a
// full delete is safe.
export async function deleteBlockSeriesInternal(
  actor: Actor,
  seriesId: string,
): Promise<{ seriesId: string }> {
  const [series] = await db
    .select()
    .from(blockedTimesSeries)
    .where(eq(blockedTimesSeries.id, seriesId))
    .limit(1);
  if (!series) throw new BlockedTimeSeriesNotFoundError(seriesId);

  // Cascade removes all linked blocked_times occurrences.
  await db.delete(blockedTimesSeries).where(eq(blockedTimesSeries.id, seriesId));

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: AUDIT_ENTITY,
    entityId: seriesId,
    action: "delete",
    before: series as unknown as Record<string, unknown>,
  });

  return { seriesId };
}

export async function cancelBlockSeriesOccurrenceInternal(
  actor: Actor,
  blockId: string,
): Promise<{ seriesId: string; cancelledDate: string }> {
  const [block] = await db
    .select()
    .from(blockedTimes)
    .where(eq(blockedTimes.id, blockId))
    .limit(1);
  if (!block) throw new BlockNotFoundError(blockId);
  if (!block.seriesId) throw new NotASeriesOccurrenceError(blockId);

  const [series] = await db
    .select()
    .from(blockedTimesSeries)
    .where(eq(blockedTimesSeries.id, block.seriesId))
    .limit(1);
  if (!series) throw new BlockedTimeSeriesNotFoundError(block.seriesId);

  // Add the occurrence's PFA date to skipDates (deduped) so an edit-series
  // regenerate won't recreate it, then delete the block.
  const occurrenceDate = formatPfaDate(block.startAt);
  const nextSkipDates = Array.from(
    new Set([...series.skipDates, occurrenceDate]),
  ).sort();

  await db
    .update(blockedTimesSeries)
    .set({ skipDates: nextSkipDates })
    .where(eq(blockedTimesSeries.id, series.id));

  await db.delete(blockedTimes).where(eq(blockedTimes.id, blockId));

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: AUDIT_ENTITY,
    entityId: series.id,
    action: "update",
    before: { skipDates: series.skipDates },
    after: { skipDates: nextSkipDates, cancelledOccurrence: occurrenceDate },
  });

  return { seriesId: series.id, cancelledDate: occurrenceDate };
}
