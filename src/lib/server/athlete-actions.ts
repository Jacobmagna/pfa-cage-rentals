// Internal athlete + athlete→program mutation logic. Lives outside any
// "use server" file because Next.js exposes every async export from a
// "use server" file as a public RPC endpoint — and these functions take
// the actor as a parameter, so exposing them directly would let anyone
// forge an admin identity. The public, requireRole("admin")-gated
// wrappers live in src/app/admin/attendance/roster/actions.ts.
//
// Mirrors src/lib/server/hour-log-actions.ts:
//   *Internal(actor, input) — Zod-parse → business checks → db mutate →
//   safeLogAudit (sequential; neon-http has no transactions).

import { and, count, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  athletePrograms,
  athletes,
  attendanceRecords,
  programs,
} from "@/db/schema";
import { type AuthedSession } from "@/lib/authz";
import {
  AthleteHasRecordsError,
  AthleteNotFoundError,
  ProgramInactiveError,
  ProgramNotFoundError,
} from "@/lib/errors";
import {
  assignAthletesToProgramSchema,
  createAthleteSchema,
  updateAthleteSchema,
} from "@/lib/schemas/athlete";
import { safeLogAudit } from "./audit-helpers";

// Insert a new athlete, audit "athlete"/"create" with the full row.
export async function createAthleteInternal(
  actor: AuthedSession["user"],
  input: unknown,
) {
  const parsed = createAthleteSchema.parse(input);

  const [inserted] = await db
    .insert(athletes)
    .values({
      firstName: parsed.firstName,
      lastName: parsed.lastName,
      birthday: parsed.birthday ?? null,
      term: parsed.term ?? null,
    })
    .returning();

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "athlete",
    entityId: inserted.id,
    action: "create",
    after: inserted as unknown as Record<string, unknown>,
  });
  return inserted;
}

// Edit an existing athlete. Fetch first (else AthleteNotFoundError),
// Zod-parse the patch, persist, audit a changed-keys-only before/after
// diff (the audit helper's shallowDiff trims unchanged keys).
export async function updateAthleteInternal(
  actor: AuthedSession["user"],
  id: string,
  input: unknown,
) {
  const [existing] = await db
    .select()
    .from(athletes)
    .where(eq(athletes.id, id))
    .limit(1);
  if (!existing) throw new AthleteNotFoundError(id);

  const parsed = updateAthleteSchema.parse(input);

  const [updated] = await db
    .update(athletes)
    .set({
      firstName: parsed.firstName,
      lastName: parsed.lastName,
      birthday: parsed.birthday ?? null,
      term: parsed.term ?? null,
    })
    .where(eq(athletes.id, id))
    .returning();

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "athlete",
    entityId: id,
    action: "update",
    before: existing as unknown as Record<string, unknown>,
    after: updated as unknown as Record<string, unknown>,
  });
  return updated;
}

// Hard-delete an athlete (DEC-20). athletes has no soft-delete column;
// before deleting we count attendance_records — if > 0 we refuse
// (AthleteHasRecordsError) so attendance history is never silently
// cascaded away. With 0 records the delete proceeds and the athlete's
// athlete_programs rows cascade off. Audit "athlete"/"delete" w/ before.
export async function deleteAthleteInternal(
  actor: AuthedSession["user"],
  id: string,
) {
  const [existing] = await db
    .select()
    .from(athletes)
    .where(eq(athletes.id, id))
    .limit(1);
  if (!existing) throw new AthleteNotFoundError(id);

  const [{ value: recordCount }] = await db
    .select({ value: count() })
    .from(attendanceRecords)
    .where(eq(attendanceRecords.athleteId, id));
  if (recordCount > 0) {
    throw new AthleteHasRecordsError(id, recordCount);
  }

  await db.delete(athletes).where(eq(athletes.id, id));
  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "athlete",
    entityId: id,
    action: "delete",
    before: existing as unknown as Record<string, unknown>,
  });
}

export type AssignAthletesSummary = {
  mode: "add" | "move";
  programId: string;
  added: number;
  removed: number;
};

// Assign selected athletes to one program (DEC-21). The program must
// exist + be active. Neon-http has no transactions, so we issue
// sequential statements (repo convention) and audit each *effective*
// change as an "athlete_program" row keyed `${athleteId}:${programId}`.
//
//   add  — onConflictDoNothing insert per athlete; we re-read the PK to
//          tell a real insert from a no-op so we only audit + count the
//          assignments that actually landed (idempotent).
//   move — delete ALL the athlete's athlete_programs rows (auditing each
//          removal), then insert the single target row.
export async function assignAthletesToProgramInternal(
  actor: AuthedSession["user"],
  input: unknown,
): Promise<AssignAthletesSummary> {
  const parsed = assignAthletesToProgramSchema.parse(input);

  const [program] = await db
    .select()
    .from(programs)
    .where(eq(programs.id, parsed.programId))
    .limit(1);
  if (!program) throw new ProgramNotFoundError(parsed.programId);
  if (!program.active) {
    throw new ProgramInactiveError(program.id, program.name);
  }

  let added = 0;
  let removed = 0;

  for (const athleteId of parsed.athleteIds) {
    if (parsed.mode === "move") {
      // Remove every existing assignment for this athlete, auditing each.
      const existing = await db
        .select()
        .from(athletePrograms)
        .where(eq(athletePrograms.athleteId, athleteId));
      for (const row of existing) {
        await db
          .delete(athletePrograms)
          .where(
            and(
              eq(athletePrograms.athleteId, row.athleteId),
              eq(athletePrograms.programId, row.programId),
            ),
          );
        removed += 1;
        await safeLogAudit(db, {
          actorUserId: actor.id,
          entityType: "athlete_program",
          entityId: `${row.athleteId}:${row.programId}`,
          action: "delete",
          before: row as unknown as Record<string, unknown>,
        });
      }
    }

    // Insert the target assignment idempotently (composite PK).
    const inserted = await db
      .insert(athletePrograms)
      .values({ athleteId, programId: parsed.programId })
      .onConflictDoNothing()
      .returning();
    if (inserted.length > 0) {
      added += 1;
      await safeLogAudit(db, {
        actorUserId: actor.id,
        entityType: "athlete_program",
        entityId: `${athleteId}:${parsed.programId}`,
        action: "create",
        after: inserted[0] as unknown as Record<string, unknown>,
      });
    }
  }

  return { mode: parsed.mode, programId: parsed.programId, added, removed };
}

export type ArchiveAthletesSummary = { changed: number };

// Bulk-archive athletes (DEC-28). Archive is a pure visibility flag —
// it sets athletes.archivedAt (mirroring users.deletedAt) so the
// athlete drops off active rosters/pickers, but NEVER deletes the
// athlete or its athlete_programs / attendance history. Idempotent:
// only athletes currently NOT archived are flipped (already-archived
// and unknown/foreign ids are silently skipped, no audit). Neon-http
// has no transactions, so we issue sequential statements + audit each
// effective change as an "athlete"/"update" before/after diff.
export async function archiveAthletesInternal(
  actor: AuthedSession["user"],
  athleteIds: string[],
): Promise<ArchiveAthletesSummary> {
  let changed = 0;
  for (const id of athleteIds) {
    const [existing] = await db
      .select()
      .from(athletes)
      .where(eq(athletes.id, id))
      .limit(1);
    if (!existing) continue;
    if (existing.archivedAt != null) continue; // already archived — skip.

    const [updated] = await db
      .update(athletes)
      .set({ archivedAt: new Date() })
      .where(eq(athletes.id, id))
      .returning();
    changed += 1;
    await safeLogAudit(db, {
      actorUserId: actor.id,
      entityType: "athlete",
      entityId: id,
      action: "update",
      before: existing as unknown as Record<string, unknown>,
      after: updated as unknown as Record<string, unknown>,
    });
  }
  return { changed };
}

// Bulk-restore archived athletes back to the active roster (DEC-28).
// Mirror of archiveAthletesInternal: only athletes currently archived
// are flipped (archivedAt → null); non-archived and unknown ids are
// silently skipped. Audits each effective change as "athlete"/"update".
export async function restoreAthletesInternal(
  actor: AuthedSession["user"],
  athleteIds: string[],
): Promise<ArchiveAthletesSummary> {
  let changed = 0;
  for (const id of athleteIds) {
    const [existing] = await db
      .select()
      .from(athletes)
      .where(eq(athletes.id, id))
      .limit(1);
    if (!existing) continue;
    if (existing.archivedAt == null) continue; // not archived — skip.

    const [updated] = await db
      .update(athletes)
      .set({ archivedAt: null })
      .where(eq(athletes.id, id))
      .returning();
    changed += 1;
    await safeLogAudit(db, {
      actorUserId: actor.id,
      entityType: "athlete",
      entityId: id,
      action: "update",
      before: existing as unknown as Record<string, unknown>,
      after: updated as unknown as Record<string, unknown>,
    });
  }
  return { changed };
}
