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
import { formatPfaDate, pfaWallClockToUtc } from "@/lib/timezone";
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

// "YYYY-MM-DD" PFA calendar date for the current instant. Server code,
// so `new Date()` (the real now) is fine here — this is NOT a workflow
// script. Used to split past vs. future occurrences on edit/regenerate.
function todayPfaDate(): string {
  return formatPfaDate(new Date());
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

  // Edit-WHOLE-series: update the definition, then regenerate FUTURE
  // occurrences only. Past blocks (startAt before today's PFA midnight)
  // stay as a historical record. Previously-cancelled dates stay
  // cancelled — we carry forward the series' existing skipDates so a
  // re-generate won't resurrect a cancelled occurrence.
  const today = todayPfaDate();
  // UTC instant of PFA-local midnight at the start of today's PFA date —
  // the boundary between "past" blocks (kept) and "future" blocks
  // (regenerated). Built via the same DST-correct helper the generator
  // uses, so it lines up exactly with materialized startAt values.
  const cutoff = pfaWallClockToUtc(today, "00:00");

  // Regenerate occurrences for the new definition, then keep only those
  // on or after today. We intersect on the generator output rather than
  // a DB time filter so the wall-clock/DST math matches create exactly.
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
  const futureOccurrences = allOccurrences.filter((o) => o.date >= today);

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

  // Delete this series' FUTURE blocks (startAt >= start of PFA today),
  // then re-insert from the new definition. Past blocks untouched. The
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
        gte(programScheduleBlocks.startAt, cutoff),
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
          gte(programScheduleBlocks.startAt, cutoff),
        ),
      );

    if (futureOccurrences.length > 0) {
      const inserted = await db
        .insert(programScheduleBlocks)
        .values(
          futureOccurrences.map((o) => ({
            programId: parsed.programId,
            scheduledCoachId: primaryCoachId,
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

      // QA10 W3.2: re-insert the full coach set for each new future block.
      // QA-R2 #10: skip when the series has no coach.
      if (coachIds.length > 0) {
        await db.insert(programScheduleBlockCoaches).values(
          inserted.flatMap((b) =>
            coachIds.map((coachId) => ({ blockId: b.id, coachId })),
          ),
        );
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
            gte(programScheduleBlocks.startAt, cutoff),
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
    },
  });

  return { series: updated, count };
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
