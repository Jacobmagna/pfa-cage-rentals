// Internal hour-log mutation logic. Lives outside any "use server"
// file because Next.js exposes every async export from "use server"
// files as a public RPC endpoint — and this function takes the actor
// as a parameter, so exposing it would let anyone forge an admin
// identity.
//
// The public coach-side server action in
// src/app/coach/hour-log/actions.ts wraps this with requireSession().
//
// Pipeline (mirrors createSessionInternal):
//   1. Zod-parse                        — createHourLogSchema
//   2. assertCoachCanAccessProgram      — admins pass; unassigned
//      coaches get redirect()'d (throws) before any write
//   3. Program lookup + active check    — business invariant
//   4. Insert, then audit (sequential)  — see "Atomicity" below
//
// Atomicity: neon-http is stateless HTTP and does NOT support
// transactions. We insert first, then log the audit row as a
// separate statement (via safeLogAudit, which swallows + Sentry-
// captures audit failures so a logging hiccup never loses a logged
// hour). Same shape as the session create path.

import { eq } from "drizzle-orm";
import * as Sentry from "@sentry/nextjs";
import { db } from "@/db";
import { hourLogs, programs } from "@/db/schema";
import { logAudit } from "@/lib/audit";
import { assertCoachCanAccessProgram, type AuthedSession } from "@/lib/authz";
import { ProgramInactiveError, ProgramNotFoundError } from "@/lib/errors";
import { createHourLogSchema } from "@/lib/schemas/hour-log";

// Audit-log insert wrapper that swallows failures rather than letting
// an audit hiccup lose a successful insert (which we couldn't roll
// back anyway under neon-http). Sentry captures so we know. Mirrors
// session-actions.ts.
async function safeLogAudit(
  ...args: Parameters<typeof logAudit>
): Promise<void> {
  try {
    await logAudit(...args);
  } catch (auditErr) {
    Sentry.captureException(auditErr, {
      tags: { component: "audit", entityType: args[1].entityType },
      extra: { input: args[1] },
    });
    console.error("[audit] insert failed:", auditErr);
  }
}

export async function logHourInternal(
  actor: AuthedSession["user"],
  input: unknown,
) {
  const parsed = createHourLogSchema.parse(input);

  // Admins pass; a coach not assigned to the program gets redirect()'d
  // (which throws) before any write happens.
  await assertCoachCanAccessProgram(actor, parsed.programId);

  const [program] = await db
    .select()
    .from(programs)
    .where(eq(programs.id, parsed.programId))
    .limit(1);
  if (!program) throw new ProgramNotFoundError(parsed.programId);
  if (!program.active) {
    throw new ProgramInactiveError(program.id, program.name);
  }

  const [inserted] = await db
    .insert(hourLogs)
    .values({
      coachId: actor.id,
      programId: parsed.programId,
      startAt: parsed.startAt,
      endAt: parsed.endAt,
      note: parsed.note ?? null,
      createdBy: actor.id,
    })
    .returning();

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "hour_log",
    entityId: inserted.id,
    action: "create",
    after: inserted as unknown as Record<string, unknown>,
  });
  return inserted;
}
