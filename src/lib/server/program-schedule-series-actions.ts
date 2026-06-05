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

import { and, eq, gte, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
  programs,
  programScheduleBlocks,
  programScheduleSeries,
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

const AUDIT_ENTITY = "program_schedule_series";

// Program must exist and be active — same check as the single-block
// path. Throws ProgramNotFoundError / ProgramInactiveError.
async function assertProgramActive(programId: string) {
  const [program] = await db
    .select()
    .from(programs)
    .where(eq(programs.id, programId))
    .limit(1);
  if (!program) throw new ProgramNotFoundError(programId);
  if (!program.active) {
    throw new ProgramInactiveError(program.id, program.name);
  }
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

  await assertProgramActive(parsed.programId);
  await assertScheduledCoach(parsed.scheduledCoachId);

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

  const [series] = await db
    .insert(programScheduleSeries)
    .values({
      programId: parsed.programId,
      scheduledCoachId: parsed.scheduledCoachId,
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

  let count = 0;
  if (occurrences.length > 0) {
    const inserted = await db
      .insert(programScheduleBlocks)
      .values(
        occurrences.map((o) => ({
          programId: parsed.programId,
          scheduledCoachId: parsed.scheduledCoachId,
          startAt: o.startAt,
          endAt: o.endAt,
          note: parsed.note ?? null,
          seriesId: series.id,
          createdBy: actor.id,
        })),
      )
      .returning({ id: programScheduleBlocks.id });
    count = inserted.length;
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

  await assertProgramActive(parsed.programId);
  await assertScheduledCoach(parsed.scheduledCoachId);

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

  const [updated] = await db
    .update(programScheduleSeries)
    .set({
      scheduledCoachId: parsed.scheduledCoachId,
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

  // Delete this series' FUTURE blocks (startAt >= start of PFA today),
  // then re-insert from the new definition. Past blocks untouched.
  await db
    .delete(programScheduleBlocks)
    .where(
      and(
        eq(programScheduleBlocks.seriesId, seriesId),
        gte(programScheduleBlocks.startAt, cutoff),
      ),
    );

  let count = 0;
  if (futureOccurrences.length > 0) {
    const inserted = await db
      .insert(programScheduleBlocks)
      .values(
        futureOccurrences.map((o) => ({
          programId: parsed.programId,
          scheduledCoachId: parsed.scheduledCoachId,
          startAt: o.startAt,
          endAt: o.endAt,
          note: parsed.note ?? null,
          seriesId,
          createdBy: actor.id,
        })),
      )
      .returning({ id: programScheduleBlocks.id });
    count = inserted.length;
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
