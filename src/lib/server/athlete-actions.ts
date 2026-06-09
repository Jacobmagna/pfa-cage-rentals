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

import { and, count, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { db } from "@/db";
import {
  athleteMergeDismissals,
  athletePrograms,
  athletes,
  attendanceRecords,
  programs,
} from "@/db/schema";
import { type AuthedSession } from "@/lib/authz";
import {
  AthleteHasRecordsError,
  AthleteNotFoundError,
  MergeAthleteSameError,
  ProgramInactiveError,
  ProgramNotFoundError,
} from "@/lib/errors";
import {
  assignAthletesToProgramSchema,
  createAthleteSchema,
  dismissDuplicateSchema,
  mergeAthletesSchema,
  updateAthleteSchema,
} from "@/lib/schemas/athlete";
import {
  dismissalKey,
  findDuplicateGroups,
  type DupAthlete,
} from "@/lib/athlete-duplicates";
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
  programIds: string[];
  added: number;
  removed: number;
};

// Assign selected athletes to one OR MORE programs (DEC-21; QA10 W2.2).
// Every selected program must exist + be active. Neon-http has no
// transactions, so we issue sequential statements (repo convention) and
// audit each *effective* change as an "athlete_program" row keyed
// `${athleteId}:${programId}`.
//
//   add  — for each selected program, onConflictDoNothing insert per
//          athlete; we re-read the PK to tell a real insert from a no-op so
//          we only audit + count the assignments that actually landed
//          (idempotent). Keeps any existing (unselected) assignments.
//   move — delete ALL the athlete's athlete_programs rows (auditing each
//          removal), then insert the selected target rows.
//
// The cap (when enabled) applies to EVERY selected (athlete × program)
// enrollment created/updated in this submit.
export async function assignAthletesToProgramInternal(
  actor: AuthedSession["user"],
  input: unknown,
): Promise<AssignAthletesSummary> {
  const parsed = assignAthletesToProgramSchema.parse(input);

  // Validate every selected program exists + is active before any write.
  for (const programId of parsed.programIds) {
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

    // Insert each selected target assignment idempotently (composite PK).
    for (const programId of parsed.programIds) {
      const inserted = await db
        .insert(athletePrograms)
        .values({ athleteId, programId })
        .onConflictDoNothing()
        .returning();
      if (inserted.length > 0) {
        added += 1;
        await safeLogAudit(db, {
          actorUserId: actor.id,
          entityType: "athlete_program",
          entityId: `${athleteId}:${programId}`,
          action: "create",
          after: inserted[0] as unknown as Record<string, unknown>,
        });
      }
    }
  }

  // Set the per-enrollment cap for the affected (athlete, program) rows.
  // The assign form is the single source of an enrollment's cap: when the
  // box is checked we have both cap + capPeriod and write them; when it's
  // unchecked both are absent and we clear them to NULL. This UPDATE runs
  // unconditionally over the assigned athletes × selected programs so the
  // form can set, change, OR clear the cap on every submit (idempotent for
  // already-enrolled athletes in "add" mode too). The same cap applies to
  // every selected program (per-program caps are out of scope — follow-up).
  const cap = parsed.cap ?? null;
  const capPeriod = parsed.capPeriod ?? null;
  await db
    .update(athletePrograms)
    .set({ cap, capPeriod })
    .where(
      and(
        inArray(athletePrograms.programId, parsed.programIds),
        inArray(athletePrograms.athleteId, parsed.athleteIds),
      ),
    );

  return { mode: parsed.mode, programIds: parsed.programIds, added, removed };
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

// ---- Duplicate detection + merge (#17 roster dedup) ---------------------

export type MergeAthletesSummary = {
  merged: number;
  attendanceMoved: number;
  enrollmentsMoved: number;
};

// Merge one or more duplicate "source" athletes into a single "survivor".
// Mirrors mergeSyntheticCoachInternal (src/lib/server/user-actions.ts:263):
// neon-http has NO transactions, so each source is processed with a
// pre-validate-then-write, idempotent, re-runnable sequence.
//
// The two athlete-referencing tables have COMPOSITE primary keys —
// attendance_records (sessionId, athleteId) and athlete_programs
// (athleteId, programId). Re-pointing a source row whose other key already
// exists on the survivor would violate that PK. So for each source we
// re-point only the NON-colliding rows (notInArray over the survivor's
// current keys) and let the source's cascade-delete drop the colliding
// leftovers. We re-read the survivor's keys per source because they grow as
// earlier sources merge in.
//
// notInArray on an EMPTY exclusion list must mean "exclude nothing" (i.e.
// re-point ALL the source's rows) — drizzle's notInArray([]) returns a
// false predicate, so we branch and use the un-excluded UPDATE in that case.
//
// Order per source: move attendance → move enrollments → fill survivor
// birthday if blank → delete source (cascades colliding leftovers +
// dismissals) → audit.
export async function mergeAthletesInternal(
  actor: AuthedSession["user"],
  rawInput: unknown,
): Promise<MergeAthletesSummary> {
  const parsed = mergeAthletesSchema.parse(rawInput);

  // Reject the survivor appearing among its own sources (would delete the
  // record being kept).
  for (const sourceId of parsed.sourceIds) {
    if (sourceId === parsed.survivorId) {
      throw new MergeAthleteSameError(parsed.survivorId);
    }
  }

  // Mutable in-memory survivor (birthday may be backfilled mid-merge).
  const [survivor] = await db
    .select()
    .from(athletes)
    .where(eq(athletes.id, parsed.survivorId))
    .limit(1);
  if (!survivor) throw new AthleteNotFoundError(parsed.survivorId);
  let survivorBirthday = survivor.birthday;

  // Pre-validate every source exists before any write.
  const sources = [];
  for (const sourceId of parsed.sourceIds) {
    const [source] = await db
      .select()
      .from(athletes)
      .where(eq(athletes.id, sourceId))
      .limit(1);
    if (!source) throw new AthleteNotFoundError(sourceId);
    sources.push(source);
  }

  let attendanceMoved = 0;
  let enrollmentsMoved = 0;

  for (const source of sources) {
    // 1. Survivor's CURRENT keys (re-read per source — they grow).
    const survivorSessions = await db
      .select({ sessionId: attendanceRecords.sessionId })
      .from(attendanceRecords)
      .where(eq(attendanceRecords.athleteId, parsed.survivorId));
    const survivorSessionIds = survivorSessions.map((r) => r.sessionId);

    const survivorEnrollments = await db
      .select({ programId: athletePrograms.programId })
      .from(athletePrograms)
      .where(eq(athletePrograms.athleteId, parsed.survivorId));
    const survivorProgramIds = survivorEnrollments.map((r) => r.programId);

    // 2. Re-point non-colliding attendance. Empty exclusion list => no
    //    exclusions (re-point all of the source's rows).
    const attendanceWhere =
      survivorSessionIds.length > 0
        ? and(
            eq(attendanceRecords.athleteId, source.id),
            notInArray(attendanceRecords.sessionId, survivorSessionIds),
          )
        : eq(attendanceRecords.athleteId, source.id);
    const movedAttendance = await db
      .update(attendanceRecords)
      .set({ athleteId: parsed.survivorId })
      .where(attendanceWhere)
      .returning({ sessionId: attendanceRecords.sessionId });
    attendanceMoved += movedAttendance.length;

    // 3. Re-point non-colliding enrollments. Same empty-list guard.
    const enrollmentWhere =
      survivorProgramIds.length > 0
        ? and(
            eq(athletePrograms.athleteId, source.id),
            notInArray(athletePrograms.programId, survivorProgramIds),
          )
        : eq(athletePrograms.athleteId, source.id);
    const movedEnrollments = await db
      .update(athletePrograms)
      .set({ athleteId: parsed.survivorId })
      .where(enrollmentWhere)
      .returning({ programId: athletePrograms.programId });
    enrollmentsMoved += movedEnrollments.length;

    // 4. Backfill the survivor's birthday from this source if blank.
    if (survivorBirthday == null && source.birthday != null) {
      await db
        .update(athletes)
        .set({ birthday: source.birthday })
        .where(eq(athletes.id, parsed.survivorId));
      survivorBirthday = source.birthday;
    }

    // 5. Delete the source — cascade clears its colliding leftover
    //    attendance/enrollment rows + any dismissals referencing it.
    await db.delete(athletes).where(eq(athletes.id, source.id));

    // 6. Audit the merge as a source-delete.
    await safeLogAudit(db, {
      actorUserId: actor.id,
      entityType: "athlete",
      entityId: source.id,
      action: "delete",
      before: source as unknown as Record<string, unknown>,
      after: {
        mergedInto: parsed.survivorId,
        survivorName: `${survivor.firstName} ${survivor.lastName}`,
        attendanceMoved: movedAttendance.length,
        enrollmentsMoved: movedEnrollments.length,
      },
    });
  }

  return {
    merged: parsed.sourceIds.length,
    attendanceMoved,
    enrollmentsMoved,
  };
}

// Persist a "these two athletes are NOT duplicates" decision so the pair is
// never flagged again. Canonicalizes the pair (smaller id = A) and inserts
// idempotently (ON CONFLICT DO NOTHING against the unique pair index).
export async function dismissDuplicateInternal(
  actor: AuthedSession["user"],
  rawInput: unknown,
): Promise<{ athleteAId: string; athleteBId: string }> {
  const parsed = dismissDuplicateSchema.parse(rawInput);
  if (parsed.athleteAId === parsed.athleteBId) {
    throw new MergeAthleteSameError(parsed.athleteAId);
  }

  // Canonical unordered pair: A = lexicographically smaller id.
  const [athleteAId, athleteBId] = [parsed.athleteAId, parsed.athleteBId].sort(
    (x, y) => (x < y ? -1 : x > y ? 1 : 0),
  );

  // Both athletes must exist.
  for (const id of [athleteAId, athleteBId]) {
    const [row] = await db
      .select({ id: athletes.id })
      .from(athletes)
      .where(eq(athletes.id, id))
      .limit(1);
    if (!row) throw new AthleteNotFoundError(id);
  }

  await db
    .insert(athleteMergeDismissals)
    .values({ athleteAId, athleteBId, dismissedBy: actor.id })
    .onConflictDoNothing();

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "athlete",
    entityId: athleteAId,
    action: "update",
    after: { dismissedDuplicate: [athleteAId, athleteBId] },
  });

  return { athleteAId, athleteBId };
}

// View-model member for the duplicates page.
export type DuplicateGroupMember = {
  id: string;
  firstName: string;
  lastName: string;
  birthday: string | null;
  term: string | null;
  programs: string[];
  attendanceCount: number;
};

export type DuplicateGroupView = {
  matchType: "exact" | "possible";
  members: DuplicateGroupMember[];
};

export type DuplicateGroupsResult = {
  groups: DuplicateGroupView[];
  totalGroups: number;
};

// Read-only loader the duplicates page renders. No actor needed (read-only).
// Reads non-archived athletes + persisted dismissals, runs the pure
// findDuplicateGroups, then enriches the athletes that appear in groups with
// their enrolled program names + attendance counts so the UI can show
// "3 programs · 12 attended".
export async function loadDuplicateGroups(): Promise<DuplicateGroupsResult> {
  const rows = await db
    .select({
      id: athletes.id,
      firstName: athletes.firstName,
      lastName: athletes.lastName,
      birthday: athletes.birthday,
      term: athletes.term,
    })
    .from(athletes)
    .where(isNull(athletes.archivedAt));

  const dismissalRows = await db
    .select({
      athleteAId: athleteMergeDismissals.athleteAId,
      athleteBId: athleteMergeDismissals.athleteBId,
    })
    .from(athleteMergeDismissals);
  const dismissed = new Set(
    dismissalRows.map((d) => dismissalKey(d.athleteAId, d.athleteBId)),
  );

  const dupInput: DupAthlete[] = rows.map((r) => ({
    id: r.id,
    firstName: r.firstName,
    lastName: r.lastName,
    birthday: r.birthday,
  }));
  const groups = findDuplicateGroups(dupInput, dismissed);

  if (groups.length === 0) {
    return { groups: [], totalGroups: 0 };
  }

  // Base athlete rows keyed by id (only those we read).
  const byId = new Map(rows.map((r) => [r.id, r]));

  // Enrich only the athletes that appear in a group.
  const memberIds = groups.flatMap((g) => g.athleteIds);

  // Program names per athlete.
  const enrollmentRows = await db
    .select({
      athleteId: athletePrograms.athleteId,
      programName: programs.name,
    })
    .from(athletePrograms)
    .innerJoin(programs, eq(programs.id, athletePrograms.programId))
    .where(inArray(athletePrograms.athleteId, memberIds));
  const programsByAthlete = new Map<string, string[]>();
  for (const row of enrollmentRows) {
    const list = programsByAthlete.get(row.athleteId);
    if (list) list.push(row.programName);
    else programsByAthlete.set(row.athleteId, [row.programName]);
  }

  // Attendance counts per athlete.
  const attendanceRows = await db
    .select({
      athleteId: attendanceRecords.athleteId,
      value: count(),
    })
    .from(attendanceRecords)
    .where(inArray(attendanceRecords.athleteId, memberIds))
    .groupBy(attendanceRecords.athleteId);
  const attendanceByAthlete = new Map(
    attendanceRows.map((r) => [r.athleteId, r.value]),
  );

  const groupViews: DuplicateGroupView[] = groups.map((g) => ({
    matchType: g.matchType,
    members: g.athleteIds.map((id) => {
      const base = byId.get(id)!;
      return {
        id: base.id,
        firstName: base.firstName,
        lastName: base.lastName,
        birthday: base.birthday,
        term: base.term,
        programs: programsByAthlete.get(id) ?? [],
        attendanceCount: attendanceByAthlete.get(id) ?? 0,
      };
    }),
  }));

  return { groups: groupViews, totalGroups: groupViews.length };
}
