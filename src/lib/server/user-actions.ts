// Internal user-lifecycle mutations. Outside any "use server" file
// because Next.js exposes every async export from "use server" as a
// public RPC endpoint — these take the actor as a parameter, so direct
// exposure would let anyone forge admin identity.
//
// Public wrapper in src/app/admin/coaches/[id]/actions.ts gates this
// with requireRole("admin"). The Privacy Policy (4720424) promises to
// "anonymize your account and remove your displayed name from session
// rows within 14 days" — this action is how we keep that promise.
//
// Soft-delete shape (J9):
//   - `deletedAt`   ← now()
//   - `name`        ← "Former coach"
//   - `email`       ← deleted-<id>@pfacagerentals.invalid
//                     (RFC 2606 reserved TLD; can never collide with
//                     a real address; frees the real email for re-
//                     signup if the coach returns)
//   - `image`       ← NULL (avatar URL would still identify them)
//
// Billing rows (sessions_billing, coach_rate_overrides) are NOT
// touched — FKs by coachId keep historical reports + the audit log
// accurate. Active-coach surfaces filter `isNull(users.deletedAt)`;
// reports + audit log do not, so historical rows still join.
//
// Audit log: entityType="user", entityId=coachId, action="delete",
// before-snapshot is the full pre-anonymization row. Same safeLogAudit
// pattern as session/block actions — neon-http can't transact, so the
// audit insert is sequential and Sentry-captured on failure.

import { eq } from "drizzle-orm";
import * as Sentry from "@sentry/nextjs";
import { db } from "@/db";
import {
  accounts,
  sessions as authSessions,
  coachRateOverrides,
  sessionsBilling,
  users,
  verificationTokens,
} from "@/db/schema";
import { logAudit } from "@/lib/audit";
import type { AuthedSession } from "@/lib/authz";
import {
  CannotDeleteAdminError,
  CoachAlreadyDeletedError,
  CoachNotFoundError,
  MergeSourceNotSyntheticError,
  MergeTargetSameAsSourceError,
} from "@/lib/errors";
import { deleteCoachSchema } from "@/lib/schemas/user";

export const FORMER_COACH_NAME = "Former coach";

/** Returns the anonymized email for a given user id. */
export function anonymizedEmailFor(userId: string): string {
  return `deleted-${userId}@pfacagerentals.invalid`;
}

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
    console.error("[audit] user delete insert failed:", auditErr);
  }
}

export async function deleteCoachInternal(
  actor: AuthedSession["user"],
  input: unknown,
) {
  const parsed = deleteCoachSchema.parse(input);

  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.id, parsed.coachId))
    .limit(1);
  if (!existing) {
    throw new CoachNotFoundError(parsed.coachId);
  }
  if (existing.role === "admin") {
    throw new CannotDeleteAdminError(parsed.coachId);
  }
  if (existing.deletedAt !== null) {
    throw new CoachAlreadyDeletedError(parsed.coachId);
  }

  const now = new Date();
  const anonymizedEmail = anonymizedEmailFor(existing.id);

  const [updated] = await db
    .update(users)
    .set({
      deletedAt: now,
      name: FORMER_COACH_NAME,
      email: anonymizedEmail,
      image: null,
    })
    .where(eq(users.id, parsed.coachId))
    .returning();

  // Strip every Auth.js handle pointed at this user:
  //   - authSessions: kicks active cookies. Next request finds no
  //     matching session token and bounces to /.
  //   - accounts: deletes the OAuth provider link. The deleted coach
  //     can later sign back in with the same Google account and gets
  //     a brand-new user row (since email + account link are both
  //     gone) — they're a fresh user as far as we're concerned. This
  //     fulfills "no longer linked to your identity" beyond just the
  //     name scrub.
  //   - verificationTokens: keyed by email (identifier), not userId.
  //     Drop any pending magic-link tokens for the original email so
  //     a half-clicked link can't resurrect the old session.
  await db.delete(authSessions).where(eq(authSessions.userId, parsed.coachId));
  await db.delete(accounts).where(eq(accounts.userId, parsed.coachId));
  await db
    .delete(verificationTokens)
    .where(eq(verificationTokens.identifier, existing.email));

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "user",
    entityId: parsed.coachId,
    action: "delete",
    before: existing as unknown as Record<string, unknown>,
    after: updated as unknown as Record<string, unknown>,
  });

  return updated;
}

// Predicate: a "synthetic" coach is one created by the historical
// import flow (pseudo-account, no auth tie). Email pattern is the
// canonical signal — see syntheticEmailFor() in src/lib/import/commit.ts.
export function isSyntheticUserEmail(email: string): boolean {
  return email.endsWith("@imported.local");
}

/**
 * Merge a synthetic import coach into a real coach. Re-points every
 * sessions_billing row from source → target, drops any (empty in
 * practice) rate overrides on the source, then hard-deletes the
 * source user. Audit log captures both the source-delete and the
 * row-count moved.
 *
 * Constraints:
 *   - source must be a synthetic user (email @imported.local). Two
 *     real coaches don't merge via this path — that's a different
 *     identity-resolution problem.
 *   - source ≠ target.
 *
 * No transaction (neon-http) — the order is:
 *   1. UPDATE sessions_billing.coach_id source → target
 *   2. DELETE coach_rate_overrides where coach_id = source (safety)
 *   3. DELETE users WHERE id = source
 *   4. Audit
 * If a step 2/3 hiccup leaves a synthetic with 0 sessions around,
 * the admin can just re-run merge → step 1 is a no-op, steps 2/3
 * complete the cleanup.
 */
export async function mergeSyntheticCoachInternal(
  actor: AuthedSession["user"],
  sourceId: string,
  targetId: string,
): Promise<{ movedSessions: number }> {
  if (sourceId === targetId) {
    throw new MergeTargetSameAsSourceError(sourceId);
  }

  const [source] = await db
    .select()
    .from(users)
    .where(eq(users.id, sourceId))
    .limit(1);
  if (!source) throw new CoachNotFoundError(sourceId);
  if (!isSyntheticUserEmail(source.email)) {
    throw new MergeSourceNotSyntheticError(sourceId);
  }

  const [target] = await db
    .select()
    .from(users)
    .where(eq(users.id, targetId))
    .limit(1);
  if (!target) throw new CoachNotFoundError(targetId);

  const moved = await db
    .update(sessionsBilling)
    .set({ coachId: targetId })
    .where(eq(sessionsBilling.coachId, sourceId))
    .returning({ id: sessionsBilling.id });

  await db
    .delete(coachRateOverrides)
    .where(eq(coachRateOverrides.coachId, sourceId));

  await db.delete(users).where(eq(users.id, sourceId));

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "user",
    entityId: sourceId,
    action: "delete",
    before: source as unknown as Record<string, unknown>,
    after: {
      mergedInto: targetId,
      targetName: target.name ?? target.email,
      sessionsMoved: moved.length,
    },
  });

  return { movedSessions: moved.length };
}
