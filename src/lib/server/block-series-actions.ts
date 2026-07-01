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

import { and, eq, gt, gte, lt } from "drizzle-orm";
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
  createBlockSeriesSchema,
  editBlockSeriesSchema,
} from "@/lib/schemas/block";
import { generateOccurrences, type Occurrence } from "@/lib/schedule-recurrence";
import { formatPfaDate, formatPfaTime12h } from "@/lib/timezone";
import { safeLogAudit } from "./audit-helpers";

const AUDIT_ENTITY = "blocked_times_series";

type Actor = AuthedSession["user"];

// A rental occurrence we skipped, surfaced to the admin so they can follow up.
export type SkippedRental = {
  date: string; // PFA "YYYY-MM-DD"
  coachName: string;
  label: string; // e.g. "Mon, Aug 3 · 3:00 – 5:00 PM · Coach Smith"
};

export type BlockSeriesResult = {
  seriesId: string | null; // null when nothing could be blocked (no series made)
  created: number;
  skippedRentals: SkippedRental[];
  skippedBlocked: number; // occurrences that were already blocked (silent skip)
};

// Half-open [start, end) overlap — matches the blocked_times / sessions_billing
// tsrange EXCLUDE constraints (adjacent intervals that merely touch don't
// overlap).
function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() < bEnd.getTime() && aEnd.getTime() > bStart.getTime();
}

async function getResourceOrThrow(resourceId: string) {
  const [row] = await db
    .select()
    .from(resources)
    .where(eq(resources.id, resourceId))
    .limit(1);
  if (!row) throw new ResourceNotFoundError(resourceId);
  return row;
}

// Classify each occurrence against what's already on the resource in the
// occurrences' time window, applying the skip-and-continue policy. One
// range-scan of sessions + blocks (not a query per occurrence) keeps this
// cheap even at the 366-occurrence cap. `excludeSeriesId` drops that series'
// OWN blocks from the "already blocked" set (used on edit, where the series'
// future blocks are being regenerated).
async function partitionOccurrences(
  resourceId: string,
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
        coachName,
        label: `${formatPfaDate(o.startAt)} · ${formatPfaTime12h(
          o.startAt,
        )} – ${formatPfaTime12h(o.endAt)} · ${coachName}`,
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
  await getResourceOrThrow(parsed.resourceId);

  // Generate FIRST so an invalid recurrence (over-cap, etc.) throws before we
  // write anything.
  const occurrences = generateOccurrences({
    daysOfWeek: parsed.daysOfWeek,
    startTime: parsed.startTime,
    endTime: parsed.endTime,
    startsOn: parsed.startsOn,
    endsOn: parsed.endsOn,
    frequency: parsed.frequency,
    interval: parsed.interval,
  });

  const { toInsert, skippedRentals, skippedBlocked } =
    await partitionOccurrences(parsed.resourceId, occurrences);

  // Nothing bookable → don't create an empty series; hand back the report so
  // the UI can say "couldn't block any — all N already rented/blocked".
  if (toInsert.length === 0) {
    return { seriesId: null, created: 0, skippedRentals, skippedBlocked };
  }

  const [series] = await db
    .insert(blockedTimesSeries)
    .values({
      resourceId: parsed.resourceId,
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

  await db.insert(blockedTimes).values(
    toInsert.map((o) => ({
      resourceId: parsed.resourceId,
      startAt: o.startAt,
      endAt: o.endAt,
      reason: parsed.reason,
      seriesId: series.id,
      createdBy: actor.id,
    })),
  );

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: AUDIT_ENTITY,
    entityId: series.id,
    action: "create",
    after: {
      ...(series as unknown as Record<string, unknown>),
      occurrenceCount: toInsert.length,
      skippedRentalCount: skippedRentals.length,
      skippedBlockedCount: skippedBlocked,
    },
  });

  return {
    seriesId: series.id,
    created: toInsert.length,
    skippedRentals,
    skippedBlocked,
  };
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
  await getResourceOrThrow(parsed.resourceId);

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

    const { toInsert, skippedRentals, skippedBlocked } =
      await partitionOccurrences(parsed.resourceId, futureOccurrences);

    if (toInsert.length > 0) {
      await db.insert(blockedTimes).values(
        toInsert.map((o) => ({
          resourceId: parsed.resourceId,
          startAt: o.startAt,
          endAt: o.endAt,
          reason: parsed.reason,
          seriesId,
          createdBy: actor.id,
        })),
      );
    }
    result = {
      seriesId,
      created: toInsert.length,
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
    } catch {
      /* cleanup best-effort */
    }
    if (futureBlocks.length > 0) {
      try {
        await db.insert(blockedTimes).values(futureBlocks);
      } catch {
        /* restore best-effort */
      }
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
      resourceId: parsed.resourceId,
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
