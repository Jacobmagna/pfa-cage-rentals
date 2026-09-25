// Internal mutation logic for RECUR-a recurring program-schedule
// series. Lives outside any "use server" file for the same reason as
// program-schedule-actions.ts: these functions take the actor as a
// parameter, so exposing them as Next.js RPC endpoints would let anyone
// forge an admin identity. Public wrappers in
// src/app/admin/hour-log/schedule/actions.ts gate them with
// requireRole("admin").
//
// Model (locked by Jacob): a series is a weekly recurrence (one or more
// weekdays + a wall-clock window + a season start/end). We MATERIALIZE
// one program_schedule_blocks row per occurrence so the existing grid +
// FEAT-16 reconciliation keep working unchanged. The series row is the
// editable definition; the blocks are the occurrences.
//
// neon-http has NO transactions, so each mutation is a sequence of
// queries (insert series → bulk-insert blocks → audit), exactly like the
// single-block path. safeLogAudit swallows + Sentry-captures audit
// failures so a logging hiccup never loses a mutation.
//
// Validation mirrors the single-block path:
//   1. Zod-parse
//   2. Program exists + active (ProgramNotFound / ProgramInactive)
//   3. Scheduled coach is a non-deleted role=coach user (CoachNotFound)
//   4. Generate occurrences (pure, capped at MAX_OCCURRENCES)
//   5. Insert / regenerate / cancel
//   6. Audit

import { and, eq, gte, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
  blockedTimes,
  programs,
  programScheduleBlockCoaches,
  programScheduleBlocks,
  programScheduleSeries,
  programScheduleSeriesCoaches,
  users,
} from "@/db/schema";
import type { AuthedSession } from "@/lib/authz";
import {
  CoachNotFoundError,
  NotASeriesOccurrenceError,
  ProgramInactiveError,
  ProgramNotFoundError,
  ProgramScheduleBlockNotFoundError,
  ProgramScheduleSeriesNotFoundError,
} from "@/lib/errors";
import {
  createProgramScheduleSeriesSchema,
  editProgramScheduleSeriesSchema,
} from "@/lib/schemas/program-schedule";
import { generateOccurrences } from "@/lib/schedule-recurrence";
import { planOccurrenceCoaches } from "@/lib/schedule-occurrence-coaches";
import { formatPfaDate } from "@/lib/timezone";
import { safeLogAudit } from "./audit-helpers";
import {
  assertResourcesFree,
  insertProgramResourceBlocks,
  programOccupancyReason,
  type ProgramResourceBlockRow,
} from "./program-resource-blocks";

const AUDIT_ENTITY = "program_schedule_series";

// Program must exist and be active — same check as the single-block
// path. Throws ProgramNotFoundError / ProgramInactiveError. Returns the
// program NAME so occupancy blocked_times can stamp reason "Program: <name>".
async function assertProgramActive(programId: string): Promise<string> {
  const [program] = await db
    .select()
    .from(programs)
    .where(eq(programs.id, programId))
    .limit(1);
  if (!program) throw new ProgramNotFoundError(programId);
  if (!program.active) {
    throw new ProgramInactiveError(program.id, program.name);
  }
  return program.name;
}

// Scheduled coach must be a non-deleted user with role = "coach".
// Throws CoachNotFoundError otherwise. Same rule as the single-block path.
async function assertScheduledCoach(coachId: string) {
  const [coach] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.id, coachId),
        eq(users.role, "coach"),
        isNull(users.deletedAt),
      ),
    )
    .limit(1);
  if (!coach) throw new CoachNotFoundError(coachId);
}

export async function createProgramScheduleSeriesInternal(
  actor: AuthedSession["user"],
  input: unknown,
) {
  const parsed = createProgramScheduleSeriesSchema.parse(input);

  const programName = await assertProgramActive(parsed.programId);
  // QA10 W3.2: full coach set; primary = [0]. Validate each, dedupe.
  // QA-R2 #10: coach is OPTIONAL — empty array = no coach (primary = null).
  const primaryCoachId = parsed.scheduledCoachIds[0] ?? null;
  for (const coachId of parsed.scheduledCoachIds) {
    await assertScheduledCoach(coachId);
  }
  const coachIds = [...new Set(parsed.scheduledCoachIds)];

  // Generate FIRST so an invalid recurrence (over-cap, etc.) throws
  // before we write the series row — no orphan series on a bad range.
  const occurrences = generateOccurrences({
    daysOfWeek: parsed.daysOfWeek,
    startTime: parsed.startTime,
    endTime: parsed.endTime,
    startsOn: parsed.startsOn,
    endsOn: parsed.endsOn,
    frequency: parsed.frequency,
    interval: parsed.interval,
  });

  // QA10 W3.3: occupied resources → one linked blocked_time per occurrence.
  // neon-http has no transactions, so PRE-VALIDATE every occurrence × resource
  // is free BEFORE writing the series / blocks (no orphan on conflict).
  const resourceIds = [...new Set(parsed.resourceIds)];
  if (resourceIds.length > 0) {
    for (const o of occurrences) {
      await assertResourcesFree(resourceIds, o.startAt, o.endAt);
    }
  }

  const [series] = await db
    .insert(programScheduleSeries)
    .values({
      programId: parsed.programId,
      scheduledCoachId: primaryCoachId,
      daysOfWeek: parsed.daysOfWeek,
      frequency: parsed.frequency,
      interval: parsed.interval,
      startTime: parsed.startTime,
      endTime: parsed.endTime,
      startsOn: parsed.startsOn,
      endsOn: parsed.endsOn,
      note: parsed.note ?? null,
      createdBy: actor.id,
    })
    .returning();

  // QA-R2 #10: only write coach join rows when a coach is assigned.
  if (coachIds.length > 0) {
    await db
      .insert(programScheduleSeriesCoaches)
      .values(coachIds.map((coachId) => ({ seriesId: series.id, coachId })));
  }

  let count = 0;
  if (occurrences.length > 0) {
    const inserted = await db
      .insert(programScheduleBlocks)
      .values(
        occurrences.map((o) => ({
          programId: parsed.programId,
          scheduledCoachId: primaryCoachId,
          startAt: o.startAt,
          endAt: o.endAt,
          note: parsed.note ?? null,
          seriesId: series.id,
          createdBy: actor.id,
        })),
      )
      .returning({
        id: programScheduleBlocks.id,
        startAt: programScheduleBlocks.startAt,
        endAt: programScheduleBlocks.endAt,
      });
    count = inserted.length;

    // QA10 W3.2: copy the full coach set onto every materialized block.
    // QA-R2 #10: skip when the series has no coach.
    if (coachIds.length > 0) {
      await db.insert(programScheduleBlockCoaches).values(
        inserted.flatMap((b) =>
          coachIds.map((coachId) => ({ blockId: b.id, coachId })),
        ),
      );
    }

    // QA10 W3.3: one linked blocked_time per (occurrence block × resource),
    // bulk-inserted in a single statement. The series' resource set is
    // PERSISTED implicitly via these linked rows — the edit form derives it
    // back on read (no separate series-resources table).
    if (resourceIds.length > 0) {
      const reason = programOccupancyReason(programName);
      const rows: ProgramResourceBlockRow[] = inserted.flatMap((b) =>
        resourceIds.map((resourceId) => ({
          programScheduleBlockId: b.id,
          resourceId,
          startAt: b.startAt,
          endAt: b.endAt,
          reason,
          createdBy: actor.id,
        })),
      );
      await insertProgramResourceBlocks(rows);
    }
  }

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: AUDIT_ENTITY,
    entityId: series.id,
    action: "create",
    after: {
      ...(series as unknown as Record<string, unknown>),
      occurrenceCount: count,
    },
  });

  return { series, count };
}

export async function editProgramScheduleSeriesInternal(
  actor: AuthedSession["user"],
  seriesId: string,
  input: unknown,
) {
  const [existing] = await db
    .select()
    .from(programScheduleSeries)
    .where(eq(programScheduleSeries.id, seriesId))
    .limit(1);
  if (!existing) throw new ProgramScheduleSeriesNotFoundError(seriesId);

  const parsed = editProgramScheduleSeriesSchema.parse(input);

  const programName = await assertProgramActive(parsed.programId);
  // QA10 W3.2: full coach set; primary = [0]. Validate each, dedupe.
  // QA-R2 #10: coach is OPTIONAL — empty array = no coach (primary = null).
  const primaryCoachId = parsed.scheduledCoachIds[0] ?? null;
  for (const coachId of parsed.scheduledCoachIds) {
    await assertScheduledCoach(coachId);
  }
  const coachIds = [...new Set(parsed.scheduledCoachIds)];
  // QA10 W3.3: the series' resource set comes fresh on each save.
  const resourceIds = [...new Set(parsed.resourceIds)];

  // 🔴 READ THE OUTGOING COACH SET *BEFORE* ANYTHING OVERWRITES IT.
  // This is the baseline the preservation rule compares every future
  // occurrence against (`schedule-occurrence-coaches.ts`), and the delete
  // ~40 lines below destroys it. Move this read after that delete and the
  // rule does not error — it INVERTS: every occurrence would be compared
  // against an empty set, every one would look individually assigned, and a
  // coach change would silently apply to nothing at all.
  //
  // 📌 The join table is the authority, not `series.scheduled_coach_id`.
  // Migration `0025` backfilled it from that column, and both write paths
  // (create above, edit below) rewrite the two together, so a series with a
  // coach always has its join rows. No fallback is written here on purpose:
  // a branch that cannot run is a decoy for the next reader (rule 27).
  const previousSeriesCoachIds = (
    await db
      .select({ coachId: programScheduleSeriesCoaches.coachId })
      .from(programScheduleSeriesCoaches)
      .where(eq(programScheduleSeriesCoaches.seriesId, seriesId))
  ).map((r) => r.coachId);

  // Edit-WHOLE-series: update the definition, then regenerate FUTURE
  // occurrences only. Occurrences that have ALREADY STARTED — including
  // ones completed earlier TODAY — stay as a historical record (rewriting
  // a finished session could orphan an hour-log reconciled against it).
  // Previously-cancelled dates stay cancelled — we carry forward the
  // series' existing skipDates so a re-generate won't resurrect a
  // cancelled occurrence.
  //
  // The past/future boundary is `now` (the current instant), NOT PFA
  // midnight today: an occurrence with startAt >= now is future
  // (regenerated); startAt < now is past/in-progress and untouched. This
  // single `now` is reused for the occurrence split, the snapshot SELECT,
  // the delete, the regenerate, and the catch-block cleanup so the
  // snapshot/restore saga covers the IDENTICAL set of rows.
  const now = new Date();

  // Regenerate occurrences for the new definition, then keep only those
  // whose start is in the future. We split on the generator output's UTC
  // startAt (matching materialized block startAt exactly) against `now`.
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

  // QA10 W3.3: PRE-VALIDATE every future occurrence × resource BEFORE any
  // mutation (neon-http has no transactions). A conflict here aborts the
  // edit with the series + its future occupancy fully intact. We exclude
  // this series' OWN future occupancy blocks (about to be regenerated) via
  // excludeSeriesId, so the series doesn't self-conflict; manually-created
  // (NULL-linked) blocked_times are still checked.
  if (resourceIds.length > 0) {
    for (const o of futureOccurrences) {
      await assertResourcesFree(resourceIds, o.startAt, o.endAt, {
        excludeSeriesId: seriesId,
      });
    }
  }

  const [updated] = await db
    .update(programScheduleSeries)
    .set({
      scheduledCoachId: primaryCoachId,
      programId: parsed.programId,
      daysOfWeek: parsed.daysOfWeek,
      frequency: parsed.frequency,
      interval: parsed.interval,
      startTime: parsed.startTime,
      endTime: parsed.endTime,
      startsOn: parsed.startsOn,
      endsOn: parsed.endsOn,
      note: parsed.note ?? null,
    })
    .where(eq(programScheduleSeries.id, seriesId))
    .returning();

  // QA10 W3.2: replace the series' full coach set.
  // QA-R2 #10: empty set clears membership (delete, no insert).
  await db
    .delete(programScheduleSeriesCoaches)
    .where(eq(programScheduleSeriesCoaches.seriesId, seriesId));
  if (coachIds.length > 0) {
    await db
      .insert(programScheduleSeriesCoaches)
      .values(coachIds.map((coachId) => ({ seriesId, coachId })));
  }

  // Delete this series' FUTURE blocks (startAt >= now), then re-insert
  // from the new definition. Past/in-progress blocks untouched. The
  // deleted blocks' program_schedule_block_coaches rows cascade away — as
  // do their linked occupancy blocked_times (FK ON DELETE CASCADE), so the
  // future resource slots are freed before we re-validate + re-insert.
  //
  // DATA-LOSS GUARD (neon-http has no transactions): the delete commits
  // immediately, so if ANY re-insert below fails (transient Neon error, a
  // concurrent 23P01, etc.) the future schedule would be GONE with nothing
  // replacing it. Before deleting, we SNAPSHOT the exact rows about to be
  // destroyed — the future blocks, their coach links, and their linked
  // blocked_times — so we can re-create them verbatim (same IDs/links) on any
  // failure. This is a compensating-restore saga, NOT a real transaction; the
  // restore is best-effort but recreates the prior state faithfully.
  const futureBlocks = await db
    .select()
    .from(programScheduleBlocks)
    .where(
      and(
        eq(programScheduleBlocks.seriesId, seriesId),
        gte(programScheduleBlocks.startAt, now),
      ),
    );
  const futureBlockIds = futureBlocks.map((b) => b.id);
  const futureCoachLinks =
    futureBlockIds.length > 0
      ? await db
          .select()
          .from(programScheduleBlockCoaches)
          .where(inArray(programScheduleBlockCoaches.blockId, futureBlockIds))
      : [];
  const futureOccupancy =
    futureBlockIds.length > 0
      ? await db
          .select()
          .from(blockedTimes)
          .where(
            inArray(blockedTimes.programScheduleBlockId, futureBlockIds),
          )
      : [];

  // ── WHO KEEPS THEIR OWN COACH ──────────────────────────────────────────
  // Reconstruct each doomed occurrence's coach set PRIMARY-FIRST. The join
  // table has no ordering column, so the block's own `scheduledCoachId` is
  // the only surviving record of which member was primary — and the primary
  // is the name the grid tile shows. Preserving the SET while losing the
  // ORDER would quietly reassign the headline coach on every preserved date,
  // which is the same complaint this whole change exists to answer.
  const membersByBlock = new Map<string, string[]>();
  for (const link of futureCoachLinks) {
    const found = membersByBlock.get(link.blockId);
    if (found) found.push(link.coachId);
    else membersByBlock.set(link.blockId, [link.coachId]);
  }
  const coachPlan = planOccurrenceCoaches({
    occurrences: futureOccurrences,
    existing: futureBlocks.map((b) => {
      const members = membersByBlock.get(b.id) ?? [];
      const primary = b.scheduledCoachId;
      return {
        startAt: b.startAt,
        coachIds: primary
          ? [primary, ...members.filter((c) => c !== primary)]
          : members,
      };
    }),
    previousSeriesCoachIds,
    nextSeriesCoachIds: coachIds,
    applyCoachesToAll: parsed.applyCoachesToAll,
  });

  // The plan is keyed back onto the newly-inserted rows by PFA DATE, never by
  // array position: `.returning()` carries no ordering guarantee, and a
  // mis-ordered zip would put the wrong coach on the wrong day — a wrong
  // answer that still reads as a perfectly good schedule. Both invariants are
  // asserted HERE, before the destructive delete, so tripping one costs
  // nothing but an error message.
  if (coachPlan.assignments.length !== futureOccurrences.length) {
    throw new Error(
      "Internal: the coach plan and the generated occurrences disagree in " +
        "length; refusing to regenerate the series.",
    );
  }
  const coachesByDate = new Map(
    coachPlan.assignments.map((a) => [a.pfaDate, a.coachIds] as const),
  );
  if (coachesByDate.size !== futureOccurrences.length) {
    throw new Error(
      "Internal: two generated occurrences share one PFA date; refusing to " +
        "regenerate the series.",
    );
  }

  // Re-create the snapshotted prior state verbatim (same primary keys, so the
  // coach-link + occupancy FKs line back up). Best-effort: each insert is
  // guarded so a partial restore still recovers as much as possible. Called
  // from the catch below when delete/regenerate fails midway.
  async function restoreSnapshot(): Promise<void> {
    if (futureBlocks.length > 0) {
      try {
        await db.insert(programScheduleBlocks).values(futureBlocks);
      } catch {
        // Block restore failed — coach/occupancy restores below would dangle,
        // so stop here; surface the original error to the admin.
        return;
      }
    }
    if (futureCoachLinks.length > 0) {
      try {
        await db
          .insert(programScheduleBlockCoaches)
          .values(futureCoachLinks);
      } catch {
        // best-effort
      }
    }
    if (futureOccupancy.length > 0) {
      try {
        await db.insert(blockedTimes).values(futureOccupancy);
      } catch {
        // best-effort
      }
    }
  }

  let count = 0;
  try {
    await db
      .delete(programScheduleBlocks)
      .where(
        and(
          eq(programScheduleBlocks.seriesId, seriesId),
          gte(programScheduleBlocks.startAt, now),
        ),
      );

    if (futureOccurrences.length > 0) {
      const inserted = await db
        .insert(programScheduleBlocks)
        .values(
          futureOccurrences.map((o) => ({
            programId: parsed.programId,
            // Per-DATE now, not one series-wide primary: a preserved date
            // keeps the coach somebody put on it by hand.
            scheduledCoachId:
              coachesByDate.get(formatPfaDate(o.startAt))?.[0] ?? null,
            startAt: o.startAt,
            endAt: o.endAt,
            note: parsed.note ?? null,
            seriesId,
            createdBy: actor.id,
          })),
        )
        .returning({
          id: programScheduleBlocks.id,
          startAt: programScheduleBlocks.startAt,
          endAt: programScheduleBlocks.endAt,
        });
      count = inserted.length;

      // QA10 W3.2 / QA-R2 #10: write each new block's PLANNED coach set —
      // the series' set on an ordinary date, the preserved set on one
      // somebody had re-coached by hand.
      //
      // 🔴 THE GUARD IS ON THE ROW COUNT, NOT ON `coachIds.length`, and the
      // difference is a real case rather than a tidy-up: clearing the SERIES
      // to no coach leaves `coachIds` empty while preserved dates still have
      // members to write. Guarding on the series set would skip the insert
      // entirely and strip the coaches off exactly the dates this change
      // exists to protect.
      const coachLinkRows = inserted.flatMap((b) =>
        (coachesByDate.get(formatPfaDate(b.startAt)) ?? []).map((coachId) => ({
          blockId: b.id,
          coachId,
        })),
      );
      if (coachLinkRows.length > 0) {
        await db.insert(programScheduleBlockCoaches).values(coachLinkRows);
      }

      // QA10 W3.3: re-insert the linked occupancy blocked_times for the new
      // future blocks at the new times. Past blocks' occupancy is untouched.
      if (resourceIds.length > 0) {
        const reason = programOccupancyReason(programName);
        const rows: ProgramResourceBlockRow[] = inserted.flatMap((b) =>
          resourceIds.map((resourceId) => ({
            programScheduleBlockId: b.id,
            resourceId,
            startAt: b.startAt,
            endAt: b.endAt,
            reason,
            createdBy: actor.id,
          })),
        );
        await insertProgramResourceBlocks(rows);
      }
    }
  } catch (regenErr) {
    // Regenerate failed after the destructive delete (or the delete itself
    // failed). First clear any PARTIAL regenerate output for this series'
    // future window (new blocks + their cascaded coach/occupancy rows), so the
    // restore doesn't collide on the EXCLUDE constraint, then restore the
    // snapshot. Both best-effort; rethrow a clear error either way.
    try {
      await db
        .delete(programScheduleBlocks)
        .where(
          and(
            eq(programScheduleBlocks.seriesId, seriesId),
            gte(programScheduleBlocks.startAt, now),
          ),
        );
    } catch {
      // If even the cleanup fails, the restore below may partially collide;
      // still attempt it.
    }
    await restoreSnapshot();
    throw new Error(
      "Failed to update the recurring series; the original schedule was " +
        "restored. Please try again.",
      { cause: regenErr },
    );
  }

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: AUDIT_ENTITY,
    entityId: seriesId,
    action: "update",
    before: existing as unknown as Record<string, unknown>,
    after: {
      ...(updated as unknown as Record<string, unknown>),
      regeneratedFutureCount: count,
      // WHICH dates declined the series' coach set, and whether the operator
      // deliberately overrode them. An exception nobody wrote down is
      // indistinguishable from a bug the next time someone asks why one
      // Saturday has a different coach on it (rule 52).
      preservedCoachDates: coachPlan.preservedDates,
      appliedCoachesToAll: parsed.applyCoachesToAll,
    },
  });

  return {
    series: updated,
    count,
    preservedCoachCount: coachPlan.preservedCount,
    preservedCoachDates: coachPlan.preservedDates,
  };
}

export async function cancelSeriesOccurrenceInternal(
  actor: AuthedSession["user"],
  blockId: string,
) {
  const [block] = await db
    .select()
    .from(programScheduleBlocks)
    .where(eq(programScheduleBlocks.id, blockId))
    .limit(1);
  if (!block) throw new ProgramScheduleBlockNotFoundError(blockId);
  if (!block.seriesId) throw new NotASeriesOccurrenceError(blockId);

  const [series] = await db
    .select()
    .from(programScheduleSeries)
    .where(eq(programScheduleSeries.id, block.seriesId))
    .limit(1);
  if (!series) throw new ProgramScheduleSeriesNotFoundError(block.seriesId);

  // The occurrence's PFA calendar date — what the generator keys on. Add
  // it to the series' skipDates (deduped) so a later edit-series
  // regenerate won't recreate this cancelled occurrence.
  const occurrenceDate = formatPfaDate(block.startAt);
  const nextSkipDates = Array.from(
    new Set([...series.skipDates, occurrenceDate]),
  ).sort();

  await db
    .update(programScheduleSeries)
    .set({ skipDates: nextSkipDates })
    .where(eq(programScheduleSeries.id, series.id));

  await db
    .delete(programScheduleBlocks)
    .where(eq(programScheduleBlocks.id, blockId));

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
