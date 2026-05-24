// Internal session-mutation logic. Lives outside any "use server"
// file because Next.js exposes every async export from "use server"
// files as a public RPC endpoint — and these functions take the
// actor as a parameter, so exposing them would let anyone forge an
// admin identity.
//
// Public server actions in src/app/admin/sessions/actions.ts wrap
// these with requireRole("admin"). Coach-side server actions (D1)
// will wrap them with requireSession() + an enforced coachId ===
// user.id check.
//
// Pipeline (same for all 3):
//   1. Zod-parse                           — B1 schemas
//   2. Resource lookup + useType rule      — business invariant
//   3. Cross-check blocked_times           — block-vs-session app-layer
//   4. Mutation, then audit (sequential)   — see "Atomicity" below
//   5. Translate Postgres 23P01 (EXCLUDE)  — friendly SessionOverlapError
//
// Atomicity: neon-http is stateless HTTP and does NOT support
// transactions. We do the mutation first, then the audit log insert
// as a separate statement. If the audit insert fails (very rare),
// the session was created but isn't audited — detectable by:
//   SELECT s.* FROM sessions_billing s
//   LEFT JOIN audit_log a ON a.entity_id = s.id AND a.action = 'create'
//   WHERE a.id IS NULL;
// Mutation comes first so a phantom audit row never claims an event
// that didn't happen. Audit failures get Sentry-captured. If we ever
// need true atomicity (compliance/SOC2), switch to neon-serverless
// (WebSocket driver, supports transactions).

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
  BlockedTimeError,
  ResourceNotFoundError,
  SessionNotFoundError,
  SessionOverlapError,
  UseTypeValidationError,
} from "@/lib/errors";
import {
  createSessionSchema,
  updateSessionSchema,
} from "@/lib/schemas/session";

// Postgres SQLSTATE 23P01 — exclusion constraint violation. Neon's
// HTTP driver wraps errors; we walk the cause chain so a wrapped
// error still maps cleanly. Other SQLSTATEs (CHECK, FK) fall through
// untranslated and surface as generic errors — those represent app
// bugs, not user-correctable conflicts.
function isExclusionViolation(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err && err.code === "23P01") {
    return true;
  }
  if (err instanceof Error && err.cause) {
    return isExclusionViolation(err.cause);
  }
  return false;
}

// Overlap query: two ranges [a, b) and [c, d) overlap iff a < d and b > c.
// Mirrors the EXCLUDE constraint's tsrange semantics — back-to-back
// (end == next start) does NOT overlap.
async function findOverlappingBlock(
  resourceId: string,
  startAt: Date,
  endAt: Date,
) {
  const [row] = await db
    .select()
    .from(blockedTimes)
    .where(
      and(
        eq(blockedTimes.resourceId, resourceId),
        lt(blockedTimes.startAt, endAt),
        gt(blockedTimes.endAt, startAt),
      ),
    )
    .limit(1);
  return row;
}

async function findOverlappingSession(
  resourceId: string,
  startAt: Date,
  endAt: Date,
  excludeSessionId?: string,
) {
  const conditions = [
    eq(sessionsBilling.resourceId, resourceId),
    lt(sessionsBilling.startAt, endAt),
    gt(sessionsBilling.endAt, startAt),
  ];
  if (excludeSessionId) {
    conditions.push(ne(sessionsBilling.id, excludeSessionId));
  }
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
    .where(and(...conditions))
    .limit(1);
  return row;
}

// Validates that useType matches the resource's type rules. Cages
// require hitting or pitching; bullpens and weight rooms must not
// have a useType. Throws UseTypeValidationError on mismatch.
function validateUseType(
  resourceName: string,
  resourceType: "cage" | "bullpen" | "weight_room",
  useType: "hitting" | "pitching" | null | undefined,
) {
  if (resourceType === "cage") {
    if (!useType) {
      throw new UseTypeValidationError(
        `${resourceName} is a cage — choose hitting or pitching.`,
      );
    }
  } else if (useType) {
    throw new UseTypeValidationError(
      `${resourceName} is a ${resourceType} — leave use type empty.`,
    );
  }
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

// Audit-log insert wrapper that swallows failures rather than letting
// an audit hiccup roll back a successful mutation (which we couldn't
// roll back anyway under neon-http). Sentry captures so we know.
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

export async function createSessionInternal(
  actor: AuthedSession["user"],
  input: unknown,
) {
  const parsed = createSessionSchema.parse(input);
  const resource = await getResourceOrThrow(parsed.resourceId);
  validateUseType(resource.name, resource.type, parsed.useType);

  const block = await findOverlappingBlock(
    parsed.resourceId,
    parsed.startAt,
    parsed.endAt,
  );
  if (block) throw new BlockedTimeError(resource.name, block.reason);

  let inserted;
  try {
    [inserted] = await db
      .insert(sessionsBilling)
      .values({
        coachId: parsed.coachId,
        resourceId: parsed.resourceId,
        startAt: parsed.startAt,
        endAt: parsed.endAt,
        useType: parsed.useType ?? null,
        note: parsed.note,
        createdBy: actor.id,
      })
      .returning();
  } catch (err) {
    if (isExclusionViolation(err)) {
      const conflict = await findOverlappingSession(
        parsed.resourceId,
        parsed.startAt,
        parsed.endAt,
      );
      if (conflict) {
        throw new SessionOverlapError(
          resource.name,
          conflict.coachName ?? conflict.coachEmail,
          conflict.startAt,
          conflict.endAt,
        );
      }
    }
    throw err;
  }

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "session",
    entityId: inserted.id,
    action: "create",
    after: inserted as unknown as Record<string, unknown>,
  });
  return inserted;
}

export async function updateSessionInternal(
  actor: AuthedSession["user"],
  id: string,
  input: unknown,
) {
  const parsed = updateSessionSchema.parse(input);

  const [existing] = await db
    .select()
    .from(sessionsBilling)
    .where(eq(sessionsBilling.id, id))
    .limit(1);
  if (!existing) throw new SessionNotFoundError(id);

  // Merge desired final state for downstream checks. Drizzle's update
  // only persists fields present in `parsed`, but useType + block checks
  // need to know the effective post-update values.
  const finalResourceId = parsed.resourceId ?? existing.resourceId;
  const finalStartAt = parsed.startAt ?? existing.startAt;
  const finalEndAt = parsed.endAt ?? existing.endAt;
  const finalUseType =
    parsed.useType !== undefined ? parsed.useType : existing.useType;

  const resource = await getResourceOrThrow(finalResourceId);
  validateUseType(resource.name, resource.type, finalUseType);

  const block = await findOverlappingBlock(
    finalResourceId,
    finalStartAt,
    finalEndAt,
  );
  if (block) throw new BlockedTimeError(resource.name, block.reason);

  let updated;
  try {
    [updated] = await db
      .update(sessionsBilling)
      .set({
        ...(parsed.coachId !== undefined && { coachId: parsed.coachId }),
        ...(parsed.resourceId !== undefined && {
          resourceId: parsed.resourceId,
        }),
        ...(parsed.startAt !== undefined && { startAt: parsed.startAt }),
        ...(parsed.endAt !== undefined && { endAt: parsed.endAt }),
        ...(parsed.useType !== undefined && { useType: parsed.useType }),
        ...(parsed.note !== undefined && { note: parsed.note }),
      })
      .where(eq(sessionsBilling.id, id))
      .returning();
  } catch (err) {
    if (isExclusionViolation(err)) {
      const conflict = await findOverlappingSession(
        finalResourceId,
        finalStartAt,
        finalEndAt,
        id,
      );
      if (conflict) {
        throw new SessionOverlapError(
          resource.name,
          conflict.coachName ?? conflict.coachEmail,
          conflict.startAt,
          conflict.endAt,
        );
      }
    }
    throw err;
  }

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "session",
    entityId: id,
    action: "update",
    before: existing as unknown as Record<string, unknown>,
    after: updated as unknown as Record<string, unknown>,
  });
  return updated;
}

export async function deleteSessionInternal(
  actor: AuthedSession["user"],
  id: string,
) {
  const [existing] = await db
    .select()
    .from(sessionsBilling)
    .where(eq(sessionsBilling.id, id))
    .limit(1);
  if (!existing) throw new SessionNotFoundError(id);

  await db.delete(sessionsBilling).where(eq(sessionsBilling.id, id));
  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "session",
    entityId: id,
    action: "delete",
    before: existing as unknown as Record<string, unknown>,
  });
}
