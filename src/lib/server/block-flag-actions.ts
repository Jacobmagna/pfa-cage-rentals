// QA10 W3-polish15b: internal mutation logic for resolving block-
// accountability flags. Lives outside any "use server" file (same reason
// as hour-log-actions.ts) because these take the actor as a parameter, so
// exposing them as RPC would let a caller forge an admin identity. The
// public requireRole("admin")-gated wrappers live in
// src/app/admin/hour-log/actions.ts.
//
// neon-http is stateless HTTP (no transactions), so each mutation is a
// statement followed by a separate safeLogAudit (which swallows + Sentry-
// captures audit failures so a logging hiccup never loses the mutation).

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { programBlockCoachFlags } from "@/db/schema";
import { type AuthedSession } from "@/lib/authz";
import { BlockFlagNotFoundError } from "@/lib/errors";
import { safeLogAudit } from "./audit-helpers";

// Mark a stored 'cancelled' flag reviewed/acknowledged. Idempotent: if the
// flag is already reviewed we keep the original reviewer/timestamp and
// return it unchanged (never overwrite).
export async function resolveCancellationInternal(
  actor: AuthedSession["user"],
  flagId: string,
) {
  const [existing] = await db
    .select()
    .from(programBlockCoachFlags)
    .where(eq(programBlockCoachFlags.id, flagId))
    .limit(1);
  if (!existing) throw new BlockFlagNotFoundError(flagId);

  // Idempotent — already reviewed, keep the original reviewer.
  if (existing.reviewedAt) return existing;

  const [updated] = await db
    .update(programBlockCoachFlags)
    .set({ reviewedAt: new Date(), reviewedBy: actor.id })
    .where(eq(programBlockCoachFlags.id, flagId))
    .returning();

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "program_block_coach_flag",
    entityId: flagId,
    action: "update",
    before: existing as unknown as Record<string, unknown>,
    after: updated as unknown as Record<string, unknown>,
  });
  return updated;
}

// Acknowledge a DERIVED no-show by inserting a stored 'no_show' flag
// (stamped reviewed at insert — an admin Resolve IS the acknowledgement).
// Idempotent via onConflictDoNothing on the (block, coach, kind) unique
// index, so a double-tap is harmless (returns undefined the second time).
export async function resolveNoShowInternal(
  actor: AuthedSession["user"],
  blockId: string,
  coachId: string,
) {
  const [flag] = await db
    .insert(programBlockCoachFlags)
    .values({
      blockId,
      coachId,
      kind: "no_show",
      createdBy: actor.id,
      reviewedAt: new Date(),
      reviewedBy: actor.id,
    })
    .onConflictDoNothing({
      target: [
        programBlockCoachFlags.blockId,
        programBlockCoachFlags.coachId,
        programBlockCoachFlags.kind,
      ],
    })
    .returning();

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "program_block_coach_flag",
    entityId: flag?.id ?? `${blockId}:${coachId}`,
    action: "create",
    after: flag as unknown as Record<string, unknown>,
  });
  return flag;
}
