// QA2 #8 — internal admin-notes mutation logic. Lives outside any
// "use server" file so the actor-as-parameter shape can't be exposed
// as a public RPC endpoint. Public admin wrapper lives in
// src/app/admin/coaches/[id]/actions.ts (gated with requireRole).
//
// Audit log: entityType="coach_notes", entityId=coachId. Same
// safeLogAudit pattern as the handles/rate-override actions —
// neon-http can't transact, so the audit insert is sequential and
// Sentry-captured on failure.

import { and, eq, isNull } from "drizzle-orm";
import * as Sentry from "@sentry/nextjs";
import { db } from "@/db";
import { users } from "@/db/schema";
import { logAudit } from "@/lib/audit";
import type { AuthedSession } from "@/lib/authz";
import { CoachNotFoundError } from "@/lib/errors";
import { updateCoachNotesSchema } from "@/lib/schemas/coach-notes";

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
    console.error("[audit] coach-notes insert failed:", auditErr);
  }
}

export async function updateCoachNotesInternal(
  actor: AuthedSession["user"],
  input: unknown,
) {
  const parsed = updateCoachNotesSchema.parse(input);

  const [existing] = await db
    .select({ id: users.id, notes: users.notes })
    .from(users)
    .where(and(eq(users.id, parsed.coachId), isNull(users.deletedAt)))
    .limit(1);
  if (!existing) throw new CoachNotFoundError(parsed.coachId);

  const [updated] = await db
    .update(users)
    .set({ notes: parsed.notes })
    .where(eq(users.id, parsed.coachId))
    .returning({ id: users.id, notes: users.notes });

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "coach_notes",
    entityId: parsed.coachId,
    action: "update",
    before: existing as unknown as Record<string, unknown>,
    after: updated as unknown as Record<string, unknown>,
  });
  return updated;
}
