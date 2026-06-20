// Schedule Manager grant/revoke — internal mutation logic. Lives outside
// any "use server" file so the actor-as-parameter shape can't be exposed
// as a public RPC endpoint. The public admin wrapper lives in
// src/app/admin/coaches/[id]/actions.ts (gated with requireRole("admin")),
// which is the critical anti-escalation boundary: only a real admin can
// flip another user's schedule_admin flag — a coach (even a flagged one)
// never can.
//
// Audit log: entityType="user", entityId=coachId. The audit_action enum is
// locked to create/update/delete at the DB level (no migration adds new
// values), so the column stores "update"; the grant-vs-revoke semantics
// ride in the diff as `action` ("grant_schedule_admin"/"revoke_schedule_admin")
// alongside the before/after scheduleAdmin snapshot. Same safeLogAudit
// pattern as coach-notes-actions — neon-http can't transact, so the audit
// insert is sequential and Sentry-captured on failure.

import { and, eq, isNull } from "drizzle-orm";
import * as Sentry from "@sentry/nextjs";
import { db } from "@/db";
import { users } from "@/db/schema";
import { logAudit } from "@/lib/audit";
import type { AuthedSession } from "@/lib/authz";
import { CoachNotFoundError } from "@/lib/errors";

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
    console.error("[audit] schedule-admin insert failed:", auditErr);
  }
}

/**
 * Sets a coach's `schedule_admin` flag. Pure-ish + testable: the caller
 * (the requireRole("admin")-gated public action) passes the authed actor,
 * the target coach id, and the new boolean. Throws CoachNotFoundError if
 * the target user doesn't exist (or is soft-deleted). Writes an audit row
 * attributing the grant/revoke to the actor.
 */
export async function setScheduleAdminInternal(
  actor: AuthedSession["user"],
  coachId: string,
  enabled: boolean,
) {
  const [existing] = await db
    .select({ id: users.id, scheduleAdmin: users.scheduleAdmin })
    .from(users)
    .where(and(eq(users.id, coachId), isNull(users.deletedAt)))
    .limit(1);
  if (!existing) throw new CoachNotFoundError(coachId);

  const [updated] = await db
    .update(users)
    .set({ scheduleAdmin: enabled })
    .where(eq(users.id, coachId))
    .returning({ id: users.id, scheduleAdmin: users.scheduleAdmin });

  // The audit_action PG enum only accepts create/update/delete, so the
  // column stores "update"; the semantic action ("grant_schedule_admin" /
  // "revoke_schedule_admin") is stamped into the diff's `after` so it
  // survives shallowDiff (which keeps only changed keys) and the audit
  // page / grep reads clearly. before/after also carry the scheduleAdmin
  // snapshot (false→true on grant, true→false on revoke).
  const semanticAction = enabled
    ? "grant_schedule_admin"
    : "revoke_schedule_admin";
  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "user",
    entityId: coachId,
    action: "update",
    before: existing as unknown as Record<string, unknown>,
    after: {
      ...(updated as unknown as Record<string, unknown>),
      action: semanticAction,
    },
  });
  return updated;
}
