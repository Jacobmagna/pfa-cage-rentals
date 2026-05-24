// Internal blocked-time mutation logic. Lives outside any "use
// server" file because Next.js exposes every async export from "use
// server" files as a public RPC endpoint — these functions take the
// actor as a parameter, so exposing them would let anyone forge an
// admin identity.
//
// Public wrappers in src/app/admin/schedule/actions.ts gate these
// with requireRole("admin").
//
// Pipeline mirrors C6's createSessionInternal:
//   1. Zod-parse
//   2. Cross-check sessions_billing (app-layer; Postgres EXCLUDE
//      can't span tables)
//   3. Insert blocked_times row (DB EXCLUDE catches block-vs-block)
//   4. Audit log (sequential — neon-http has no transactions)
//   5. Translate SQLSTATE 23P01 → BlockOverlapError
//
// Same atomicity trade-off as the session path: audit failures are
// Sentry-captured via safeLogAudit but don't roll back the mutation.

import { and, eq, gt, lt, ne } from "drizzle-orm";
import * as Sentry from "@sentry/nextjs";
import { db } from "@/db";
import {
  blockedTimes,
  resources,
  sessionsBilling,
  users,
} from "@/db/schema";
import { logAudit } from "@/lib/audit";
import type { AuthedSession } from "@/lib/authz";
import {
  BlockConflictsWithSessionError,
  BlockNotFoundError,
  BlockOverlapError,
  ResourceNotFoundError,
} from "@/lib/errors";
import { createBlockSchema, updateBlockSchema } from "@/lib/schemas/block";

function isExclusionViolation(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err && err.code === "23P01") {
    return true;
  }
  if (err instanceof Error && err.cause) {
    return isExclusionViolation(err.cause);
  }
  return false;
}

async function findOverlappingSession(
  resourceId: string,
  startAt: Date,
  endAt: Date,
) {
  const [row] = await db
    .select({
      id: sessionsBilling.id,
      startAt: sessionsBilling.startAt,
      endAt: sessionsBilling.endAt,
      coachName: users.name,
      coachEmail: users.email,
    })
    .from(sessionsBilling)
    .innerJoin(users, eq(sessionsBilling.coachId, users.id))
    .where(
      and(
        eq(sessionsBilling.resourceId, resourceId),
        lt(sessionsBilling.startAt, endAt),
        gt(sessionsBilling.endAt, startAt),
      ),
    )
    .limit(1);
  return row;
}

async function findOverlappingBlock(
  resourceId: string,
  startAt: Date,
  endAt: Date,
  excludeBlockId?: string,
) {
  const conditions = [
    eq(blockedTimes.resourceId, resourceId),
    lt(blockedTimes.startAt, endAt),
    gt(blockedTimes.endAt, startAt),
  ];
  if (excludeBlockId) {
    conditions.push(ne(blockedTimes.id, excludeBlockId));
  }
  const [row] = await db
    .select()
    .from(blockedTimes)
    .where(and(...conditions))
    .limit(1);
  return row;
}

async function getResourceOrThrow(resourceId: string) {
  const [row] = await db
    .select()
    .from(resources)
    .where(eq(resources.id, resourceId))
    .limit(1);
  if (!row) throw new ResourceNotFoundError(resourceId);
  return row;
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
    console.error("[audit] block insert failed:", auditErr);
  }
}

export async function createBlockInternal(
  actor: AuthedSession["user"],
  input: unknown,
) {
  const parsed = createBlockSchema.parse(input);
  const resource = await getResourceOrThrow(parsed.resourceId);

  // App-layer check: block can't span an existing session.
  const conflictingSession = await findOverlappingSession(
    parsed.resourceId,
    parsed.startAt,
    parsed.endAt,
  );
  if (conflictingSession) {
    throw new BlockConflictsWithSessionError(
      resource.name,
      conflictingSession.coachName ?? conflictingSession.coachEmail,
      conflictingSession.startAt,
      conflictingSession.endAt,
    );
  }

  let inserted;
  try {
    [inserted] = await db
      .insert(blockedTimes)
      .values({
        resourceId: parsed.resourceId,
        startAt: parsed.startAt,
        endAt: parsed.endAt,
        reason: parsed.reason,
        createdBy: actor.id,
      })
      .returning();
  } catch (err) {
    if (isExclusionViolation(err)) {
      const conflict = await findOverlappingBlock(
        parsed.resourceId,
        parsed.startAt,
        parsed.endAt,
      );
      if (conflict) {
        throw new BlockOverlapError(
          resource.name,
          conflict.reason,
          conflict.startAt,
          conflict.endAt,
        );
      }
    }
    throw err;
  }

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "block",
    entityId: inserted.id,
    action: "create",
    after: inserted as unknown as Record<string, unknown>,
  });
  return inserted;
}

export async function updateBlockInternal(
  actor: AuthedSession["user"],
  id: string,
  input: unknown,
) {
  const parsed = updateBlockSchema.parse(input);

  const [existing] = await db
    .select()
    .from(blockedTimes)
    .where(eq(blockedTimes.id, id))
    .limit(1);
  if (!existing) throw new BlockNotFoundError(id);

  // Merge desired final state for downstream cross-table checks.
  const finalResourceId = parsed.resourceId ?? existing.resourceId;
  const finalStartAt = parsed.startAt ?? existing.startAt;
  const finalEndAt = parsed.endAt ?? existing.endAt;

  const resource = await getResourceOrThrow(finalResourceId);

  // App-layer: a block can't span an existing session.
  const conflictingSession = await findOverlappingSession(
    finalResourceId,
    finalStartAt,
    finalEndAt,
  );
  if (conflictingSession) {
    throw new BlockConflictsWithSessionError(
      resource.name,
      conflictingSession.coachName ?? conflictingSession.coachEmail,
      conflictingSession.startAt,
      conflictingSession.endAt,
    );
  }

  let updated;
  try {
    [updated] = await db
      .update(blockedTimes)
      .set({
        ...(parsed.resourceId !== undefined && {
          resourceId: parsed.resourceId,
        }),
        ...(parsed.startAt !== undefined && { startAt: parsed.startAt }),
        ...(parsed.endAt !== undefined && { endAt: parsed.endAt }),
        ...(parsed.reason !== undefined && { reason: parsed.reason }),
      })
      .where(eq(blockedTimes.id, id))
      .returning();
  } catch (err) {
    if (isExclusionViolation(err)) {
      const conflict = await findOverlappingBlock(
        finalResourceId,
        finalStartAt,
        finalEndAt,
        id,
      );
      if (conflict) {
        throw new BlockOverlapError(
          resource.name,
          conflict.reason,
          conflict.startAt,
          conflict.endAt,
        );
      }
    }
    throw err;
  }

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "block",
    entityId: id,
    action: "update",
    before: existing as unknown as Record<string, unknown>,
    after: updated as unknown as Record<string, unknown>,
  });
  return updated;
}

export async function deleteBlockInternal(
  actor: AuthedSession["user"],
  id: string,
) {
  const [existing] = await db
    .select()
    .from(blockedTimes)
    .where(eq(blockedTimes.id, id))
    .limit(1);
  if (!existing) throw new BlockNotFoundError(id);

  await db.delete(blockedTimes).where(eq(blockedTimes.id, id));
  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "block",
    entityId: id,
    action: "delete",
    before: existing as unknown as Record<string, unknown>,
  });
}
