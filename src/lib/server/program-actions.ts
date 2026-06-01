// Internal program + coach↔program mutation logic. Lives outside any
// "use server" file because Next.js exposes every async export from a
// "use server" file as a public RPC endpoint — and these functions take
// the actor as a parameter, so exposing them directly would let anyone
// forge an admin identity. The public, requireRole("admin")-gated
// wrappers live in src/app/admin/programs/actions.ts.
//
// Mirrors src/lib/server/athlete-actions.ts + hour-log-actions.ts:
//   *Internal(actor, input) — Zod-parse → business checks → db mutate →
//   safeLogAudit (sequential; neon-http has no transactions).
//
// Programs are soft-deleted (DEC-10): "delete" flips active=false so the
// no-cascade FKs on hour_logs / attendance_sessions keep their target.
// cap + capPeriod are co-required (DEC-03; enforced by the Zod refine +
// the DB CHECK). coach_programs is the M:N coach-assignment table (DEC-04
// / DEC-23) written with replace-set semantics below.

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { coachPrograms, programs } from "@/db/schema";
import { type AuthedSession } from "@/lib/authz";
import { ProgramNameTakenError, ProgramNotFoundError } from "@/lib/errors";
import {
  createProgramSchema,
  updateProgramSchema,
} from "@/lib/schemas/program";
import { safeLogAudit } from "./audit-helpers";

// Postgres SQLSTATE 23505 — unique_violation. Neon's HTTP driver wraps
// errors, so we walk the cause chain (same shape as session-actions'
// isExclusionViolation). We additionally match the constraint name so a
// future second unique constraint on `programs` wouldn't get mistranslated
// into ProgramNameTakenError.
function isProgramNameViolation(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err) {
    const e = err as { code?: unknown; constraint?: unknown };
    if (e.code === "23505") {
      // Only translate when it's the name constraint (or when the driver
      // didn't surface a constraint name — programs has just the one
      // unique constraint today, so an unnamed 23505 is the name one).
      if (
        e.constraint === undefined ||
        e.constraint === "programs_name_unique"
      ) {
        return true;
      }
    }
  }
  if (err instanceof Error && err.cause) {
    return isProgramNameViolation(err.cause);
  }
  return false;
}

// Insert a new program. cap/capPeriod default to null when omitted; the
// Zod refine enforces both-or-neither before we ever hit the DB. Audit
// "program"/"create" with the full row.
export async function createProgramInternal(
  actor: AuthedSession["user"],
  input: unknown,
) {
  const parsed = createProgramSchema.parse(input);

  let inserted;
  try {
    [inserted] = await db
      .insert(programs)
      .values({
        name: parsed.name,
        cap: parsed.cap ?? null,
        capPeriod: parsed.capPeriod ?? null,
        active: parsed.active ?? true,
      })
      .returning();
  } catch (err) {
    if (isProgramNameViolation(err)) {
      throw new ProgramNameTakenError(parsed.name);
    }
    throw err;
  }

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "program",
    entityId: inserted.id,
    action: "create",
    after: inserted as unknown as Record<string, unknown>,
  });
  return inserted;
}

// Edit an existing program. Fetch first (else ProgramNotFoundError),
// Zod-parse the patch, update only the provided fields. cap/capPeriod
// accept null to explicitly clear them (together — DEC-03). Audit a
// changed-keys-only before/after diff. Reactivate is just this with
// {active:true}; deactivate has its own helper for the audit clarity.
export async function updateProgramInternal(
  actor: AuthedSession["user"],
  id: string,
  input: unknown,
) {
  const [existing] = await db
    .select()
    .from(programs)
    .where(eq(programs.id, id))
    .limit(1);
  if (!existing) throw new ProgramNotFoundError(id);

  const parsed = updateProgramSchema.parse(input);

  // Build a patch containing only the keys the caller actually sent.
  // cap/capPeriod are special: `null` is a meaningful "clear" value, so
  // we distinguish present-but-null from absent via hasOwnProperty.
  const patch: {
    name?: string;
    cap?: number | null;
    capPeriod?: "week" | "month" | null;
    active?: boolean;
  } = {};
  if (parsed.name !== undefined) patch.name = parsed.name;
  if ("cap" in parsed) patch.cap = parsed.cap ?? null;
  if ("capPeriod" in parsed) patch.capPeriod = parsed.capPeriod ?? null;
  if (parsed.active !== undefined) patch.active = parsed.active;

  let updated;
  try {
    [updated] = await db
      .update(programs)
      .set(patch)
      .where(eq(programs.id, id))
      .returning();
  } catch (err) {
    if (isProgramNameViolation(err)) {
      throw new ProgramNameTakenError(parsed.name ?? existing.name);
    }
    throw err;
  }

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "program",
    entityId: id,
    action: "update",
    before: existing as unknown as Record<string, unknown>,
    after: updated as unknown as Record<string, unknown>,
  });
  return updated;
}

// Soft-delete (DEC-10): flip active=false. Fetch first (else
// ProgramNotFoundError), then audit "program"/"update" before/after.
export async function deactivateProgramInternal(
  actor: AuthedSession["user"],
  id: string,
) {
  const [existing] = await db
    .select()
    .from(programs)
    .where(eq(programs.id, id))
    .limit(1);
  if (!existing) throw new ProgramNotFoundError(id);

  const [updated] = await db
    .update(programs)
    .set({ active: false })
    .where(eq(programs.id, id))
    .returning();

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "program",
    entityId: id,
    action: "update",
    before: existing as unknown as Record<string, unknown>,
    after: updated as unknown as Record<string, unknown>,
  });
  return updated;
}

// Validate the submitted coach-id set. Strings only; dedupe so a repeated
// id can't double-insert. The program-existence + role checks happen in
// setProgramCoachesInternal.
const coachIdsSchema = z.array(z.string().min(1));

export type SetProgramCoachesSummary = {
  programId: string;
  added: number;
  removed: number;
};

// Replace-set coach assignment (DEC-04 / DEC-23). The submitted set
// becomes the program's exact coach set: we diff against the current
// coach_programs rows and write only the delta. The program must exist
// (else ProgramNotFoundError). Neon-http has no transactions, so we issue
// sequential statements (repo convention) and audit each *effective*
// change as a "coach_program" row keyed `${coachId}:${programId}`.
export async function setProgramCoachesInternal(
  actor: AuthedSession["user"],
  programId: string,
  coachIds: unknown,
): Promise<SetProgramCoachesSummary> {
  const submitted = new Set(coachIdsSchema.parse(coachIds));

  const [program] = await db
    .select()
    .from(programs)
    .where(eq(programs.id, programId))
    .limit(1);
  if (!program) throw new ProgramNotFoundError(programId);

  const currentRows = await db
    .select({ coachId: coachPrograms.coachId })
    .from(coachPrograms)
    .where(eq(coachPrograms.programId, programId));
  const current = new Set(currentRows.map((r) => r.coachId));

  const toAdd = [...submitted].filter((id) => !current.has(id));
  const toRemove = [...current].filter((id) => !submitted.has(id));

  let added = 0;
  let removed = 0;

  for (const coachId of toAdd) {
    const inserted = await db
      .insert(coachPrograms)
      .values({ coachId, programId })
      .onConflictDoNothing()
      .returning();
    if (inserted.length > 0) {
      added += 1;
      await safeLogAudit(db, {
        actorUserId: actor.id,
        entityType: "coach_program",
        entityId: `${coachId}:${programId}`,
        action: "create",
        after: inserted[0] as unknown as Record<string, unknown>,
      });
    }
  }

  for (const coachId of toRemove) {
    const deleted = await db
      .delete(coachPrograms)
      .where(
        and(
          eq(coachPrograms.coachId, coachId),
          eq(coachPrograms.programId, programId),
        ),
      )
      .returning();
    if (deleted.length > 0) {
      removed += 1;
      await safeLogAudit(db, {
        actorUserId: actor.id,
        entityType: "coach_program",
        entityId: `${coachId}:${programId}`,
        action: "delete",
        before: deleted[0] as unknown as Record<string, unknown>,
      });
    }
  }

  return { programId, added, removed };
}
