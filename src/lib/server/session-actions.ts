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
//   2. Resource lookup                     — existence check
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
  coachRateOverrides,
  rateDefaults,
  resources,
  sessionCancellations,
  sessionsBilling,
  users,
} from "@/db/schema";
import { logAudit } from "@/lib/audit";
import type { AuthedSession } from "@/lib/authz";
import { computeRate, type ResourceType } from "@/lib/billing";
import { leadTimeMinutes } from "@/lib/cancellation";
import {
  BlockedTimeError,
  ResourceNotFoundError,
  SessionNotFoundError,
  SessionOverlapError,
} from "@/lib/errors";
import {
  createSessionBatchSchema,
  createSessionSchema,
  effectiveResourceId,
  updateSessionSchema,
} from "@/lib/schemas/session";

// Resolves the per-30-min cents rate to stamp on a new (or edited)
// session row. Reads the coach's override + the resource-type default
// from the DB, then delegates to billing.computeRate.
//
// Exported so the historical-import path (src/lib/server/import-actions.ts)
// can stamp rows with the correct snapshotted rate instead of falling
// through the schema default of 0.
export async function resolveRateCents(args: {
  coachId: string;
  resourceType: ResourceType;
  // GROUP-RATE (4th tier): when true AND resourceType === "weight_room",
  // resolve the DISTINCT group rate via the safe fallback chain
  // (coach group override → facility group default → regular weight-room
  // rate). Defaults to false, so every existing caller resolves the exact
  // same rate as before — the byte-identical guarantee for cage / bullpen /
  // regular weight-room paths.
  isGroupSession?: boolean;
}): Promise<number> {
  const [override] = await db
    .select()
    .from(coachRateOverrides)
    .where(
      and(
        eq(coachRateOverrides.coachId, args.coachId),
        eq(coachRateOverrides.resourceType, args.resourceType),
      ),
    );
  const defaults = await db.select().from(rateDefaults);
  const defaultsMap: Record<ResourceType, number> = {
    cage: defaults.find((d) => d.type === "cage")?.ratePer30MinCents ?? 2200,
    bullpen: defaults.find((d) => d.type === "bullpen")?.ratePer30MinCents ?? 2200,
    weight_room:
      defaults.find((d) => d.type === "weight_room")?.ratePer30MinCents ?? 700,
  };
  // Facility group default lives on the weight_room rate_defaults row.
  // NULL when unconfigured → the fallback chain drops through to the
  // regular weight-room rate (never overcharge).
  const groupWeightRoomDefaultCents =
    defaults.find((d) => d.type === "weight_room")?.groupRatePer30MinCents ??
    null;
  return computeRate({
    coachId: args.coachId,
    resourceType: args.resourceType,
    overrides: override
      ? [
          {
            coachId: override.coachId,
            resourceType: override.resourceType,
            ratePer30MinCents: override.ratePer30MinCents,
            groupRatePer30MinCents: override.groupRatePer30MinCents,
          },
        ]
      : [],
    defaults: defaultsMap,
    isGroupSession: args.isGroupSession ?? false,
    groupWeightRoomDefaultCents,
  });
}

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

  const block = await findOverlappingBlock(
    parsed.resourceId,
    parsed.startAt,
    parsed.endAt,
  );
  if (block) throw new BlockedTimeError(resource.name, block.reason);

  // GROUP-RATE (4th tier): the booking-level group flag is only meaningful
  // for a weight-room slot. Any group flag on a non-weight-room resource is
  // ignored (the row is stamped is_group_session=false and billed at its
  // normal rate) — the byte-identical guarantee for every non-weight-room
  // path.
  const isGroupSessionForRow =
    resource.type === "weight_room" && parsed.isGroupSession;

  const ratePer30MinCents = await resolveRateCents({
    coachId: parsed.coachId,
    resourceType: resource.type,
    isGroupSession: isGroupSessionForRow,
  });

  let inserted;
  try {
    [inserted] = await db
      .insert(sessionsBilling)
      .values({
        coachId: parsed.coachId,
        resourceId: parsed.resourceId,
        startAt: parsed.startAt,
        endAt: parsed.endAt,
        note: parsed.note,
        ratePer30MinCents,
        isGroupSession: isGroupSessionForRow,
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
  // only persists fields present in `parsed`, but the block check + rate
  // resolution need to know the effective post-update values.
  const finalResourceId = parsed.resourceId ?? existing.resourceId;
  const finalStartAt = parsed.startAt ?? existing.startAt;
  const finalEndAt = parsed.endAt ?? existing.endAt;
  const finalCoachId = parsed.coachId ?? existing.coachId;

  const resource = await getResourceOrThrow(finalResourceId);

  const block = await findOverlappingBlock(
    finalResourceId,
    finalStartAt,
    finalEndAt,
  );
  if (block) throw new BlockedTimeError(resource.name, block.reason);

  // Group intent is PRESERVED from the existing row (editing the group flag
  // itself is out of scope), gated on the FINAL resource still being
  // weight-room. If the session moved off weight-room, the now-stale group
  // flag is cleared. Always persisting this value is a no-op when the
  // resource stayed weight-room (same value) and correctly clears it when it
  // moved off.
  const finalIsGroupSession =
    resource.type === "weight_room" && existing.isGroupSession;

  // Re-stamp ratePer30MinCents only when one of its inputs changed.
  // Editing time/note leaves the historical rate alone — this honors the
  // snapshot guarantee: a coach renegotiating their rate doesn't
  // retroactively rewrite past sessions even if an admin later edits one
  // of those sessions. When inputs DID change, the rate re-resolves with the
  // final group status: a group weight-room session whose coach changes
  // re-resolves the NEW coach's GROUP rate, while a session moved off
  // weight-room re-bills at the new resource's regular rate (group cleared).
  const inputsChanged =
    finalCoachId !== existing.coachId ||
    finalResourceId !== existing.resourceId;
  const nextRate = inputsChanged
    ? await resolveRateCents({
        coachId: finalCoachId,
        resourceType: resource.type,
        isGroupSession: finalIsGroupSession,
      })
    : existing.ratePer30MinCents;

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
        ...(parsed.note !== undefined && { note: parsed.note }),
        ratePer30MinCents: nextRate,
        isGroupSession: finalIsGroupSession,
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
  // 1b #26/27: record the cancellation for the admin pattern dashboard.
  // Best-effort (mirrors safeLogAudit) — a recording failure must NEVER
  // break the user's delete, which has already committed above. This is
  // the SINGLE delete point, so it covers both the coach self-delete and
  // the admin delete path.
  await safeRecordCancellation(actor, existing);
}

// Best-effort insert of a session_cancellations row after a rental is
// deleted. neon-http has no transactions, so the delete commits first and
// this runs as a separate statement; swallow-and-Sentry so the user's
// delete never fails on a recording hiccup. Idempotent via the sessionId
// unique index (.onConflictDoNothing) — a double-confirm is a no-op.
async function safeRecordCancellation(
  actor: AuthedSession["user"],
  existing: typeof sessionsBilling.$inferSelect,
): Promise<void> {
  try {
    const now = new Date();
    await db
      .insert(sessionCancellations)
      .values({
        sessionId: existing.id,
        coachId: existing.coachId,
        resourceId: existing.resourceId,
        startAt: existing.startAt,
        endAt: existing.endAt,
        ratePer30MinCents: existing.ratePer30MinCents,
        note: existing.note,
        cancelledAt: now,
        cancelledBy: actor.id,
        leadTimeMins: leadTimeMinutes(existing.startAt, now),
      })
      .onConflictDoNothing({ target: sessionCancellations.sessionId });
  } catch (recordErr) {
    Sentry.captureException(recordErr, {
      tags: { component: "session-cancellation", sessionId: existing.id },
      extra: { actorId: actor.id },
    });
    console.error("[cancellation] record failed:", recordErr);
  }
}

/**
 * Batch-create: insert N sessions sharing the same coach, each with its
 * own time range / note AND its own (optional) resource. Used by the
 * multi-slot UI ("create 8 back-to-back 30-min lessons in Cage 3 from
 * 10 AM to 2 PM" — or a mix across Cage 1, Cage 2, and a bullpen).
 *
 * MULTI-RESOURCE money rule: each slot resolves to an effective
 * resourceId (its own, else the top-level default). Every row is billed
 * at ITS resource type's rate — so a cage slot and a bullpen slot in the
 * same batch get the cage rate and the bullpen rate respectively. The
 * rate is resolved ONCE per distinct resource and cached.
 *
 * Pipeline:
 *   1. Zod-parse
 *   2. Resolve each distinct effective resource: existence check +
 *      its own rate, cached in a Map.
 *   3. For each slot: cross-check blocked_times AND sessions_billing on
 *      ITS OWN resource, AND every PRIOR slot in this same batch that
 *      shares the same effective resource (so an intra-batch self-overlap
 *      is caught here, not at the DB insert). Slots on DIFFERENT cages at
 *      the same time do NOT collide.
 *   4. Bulk insert (single multi-row INSERT). Audit log a single batch
 *      entry with the created ids + their resourceIds.
 *
 * Atomicity caveat: neon-http has no transactions. We pre-validate
 * every slot before inserting any, which shuts the door on the
 * common cases (self-overlap, existing conflict). The remaining
 * race window — another mutation lands between pre-check and the
 * bulk insert — is caught by the DB's EXCLUDE constraint and
 * surfaces as a SessionOverlapError. The bulk insert is a single
 * statement, so it's either fully applied or fully rejected by
 * Postgres — no partial-insert surprises, across all cages.
 */
export async function createSessionsBatchInternal(
  actor: AuthedSession["user"],
  input: unknown,
) {
  const parsed = createSessionBatchSchema.parse(input);

  // Resolve effective resource per slot once, up front. The schema's
  // superRefine already guarantees each resolves to a non-empty string,
  // so the assertion below never fires for parsed input.
  const slotResourceIds = parsed.slots.map((s) => {
    const rid = effectiveResourceId(s, parsed.resourceId);
    if (!rid) throw new Error("unreachable: slot has no effective resourceId");
    return rid;
  });

  // GROUP-RATE (4th tier): the group flag is BOOKING-LEVEL — one constant
  // toggle for the whole batch. It only affects weight-room rows; a
  // weight-room resource in a group booking resolves the GROUP rate for its
  // rows, every non-weight-room row is untouched.
  const bookingIsGroupSession = parsed.isGroupSession;

  // For every DISTINCT effective resource: look it up (throws
  // ResourceNotFoundError per missing resource) and resolve ITS rate.
  // Cache both so each row bills at its own resource type's rate. THIS
  // IS THE CORE MONEY FIX.
  //
  // Rate-cache key correctness: the resolved rate is fully determined by
  // (resource, groupFlag). Since the group flag is a batch-level constant,
  // the resource id alone still keys the cache uniquely — a weight-room
  // resource's cached rate is the GROUP rate exactly when this booking is a
  // group booking, and the flag never varies within the batch. The
  // per-resource `isGroupSessionForResource` below folds in the
  // weight-room-only rule so a group booking of a non-weight-room resource
  // still caches (and stamps) the regular rate.
  const resourceMap = new Map<
    string,
    { resource: typeof resources.$inferSelect; rate: number }
  >();
  for (const rid of new Set(slotResourceIds)) {
    const resource = await getResourceOrThrow(rid);
    const isGroupSessionForResource =
      resource.type === "weight_room" && bookingIsGroupSession;
    const rate = await resolveRateCents({
      coachId: parsed.coachId,
      resourceType: resource.type,
      isGroupSession: isGroupSessionForResource,
    });
    resourceMap.set(rid, { resource, rate });
  }

  // Pre-validate each slot against ITS OWN effective resource:
  //   (a) against any existing block on that resource
  //   (b) against any existing session on that resource
  //   (c) against every PRIOR slot in this batch ON THE SAME resource
  //       (cross-cage same-time slots must NOT collide)
  for (let i = 0; i < parsed.slots.length; i++) {
    const slot = parsed.slots[i];
    const rid = slotResourceIds[i];
    const { resource } = resourceMap.get(rid)!;

    const block = await findOverlappingBlock(rid, slot.startAt, slot.endAt);
    if (block) throw new BlockedTimeError(resource.name, block.reason);

    const conflict = await findOverlappingSession(
      rid,
      slot.startAt,
      slot.endAt,
    );
    if (conflict) {
      throw new SessionOverlapError(
        resource.name,
        conflict.coachName ?? conflict.coachEmail,
        conflict.startAt,
        conflict.endAt,
      );
    }

    // Intra-batch self-overlap: scan earlier slots in the same array,
    // but ONLY those that share this slot's effective resource. Two
    // slots on different cages at the same time are fine. O(N^2) but
    // N ≤ 50, so worst case 1,225 comparisons — fine.
    for (let j = 0; j < i; j++) {
      const prior = parsed.slots[j];
      if (slotResourceIds[j] !== rid) continue;
      if (prior.startAt < slot.endAt && prior.endAt > slot.startAt) {
        throw new SessionOverlapError(
          resource.name,
          actor.name ?? actor.email ?? "this booking",
          prior.startAt,
          prior.endAt,
        );
      }
    }
  }

  // Bulk insert in a single statement. drizzle accepts an array on
  // .values() and emits one multi-row INSERT, which Postgres treats
  // atomically — either all rows commit or the statement fails, across
  // every cage in the batch. Each row carries its own resourceId + the
  // rate resolved for that resource's type.
  let inserted;
  try {
    inserted = await db
      .insert(sessionsBilling)
      .values(
        parsed.slots.map((s, i) => {
          const { resource } = resourceMap.get(slotResourceIds[i])!;
          // Per-row group flag: TRUE only for a weight-room slot in a group
          // booking. Non-weight-room rows are always false, regardless of the
          // booking-level flag.
          const isGroupSessionForRow =
            resource.type === "weight_room" && bookingIsGroupSession;
          return {
            coachId: parsed.coachId,
            resourceId: slotResourceIds[i],
            startAt: s.startAt,
            endAt: s.endAt,
            note: s.note ?? null,
            ratePer30MinCents: resourceMap.get(slotResourceIds[i])!.rate,
            isGroupSession: isGroupSessionForRow,
            createdBy: actor.id,
          };
        }),
      )
      .returning();
  } catch (err) {
    if (isExclusionViolation(err)) {
      // Race with a concurrent booking — one of our slots collided.
      // We don't know which one without rescanning, so surface a
      // generic overlap message scoped to the first slot's resource.
      // The coach can re-check the schedule grid.
      const firstResource = resourceMap.get(slotResourceIds[0])!.resource;
      throw new SessionOverlapError(
        firstResource.name,
        "another booking",
        parsed.slots[0].startAt,
        parsed.slots[parsed.slots.length - 1].endAt,
      );
    }
    throw err;
  }

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "session",
    // Audit log entity-per-row convention: log a single batch entry
    // keyed to the first inserted id with the full set in metadata.
    // Per-row entries would clutter the audit page; this surface is
    // a batch action. Multi-resource: record each row's resourceId
    // (not a single shared one) plus the distinct set spanned.
    entityId: inserted[0].id,
    action: "create",
    after: {
      batch: true,
      count: inserted.length,
      sessionIds: inserted.map((r) => r.id),
      coachId: parsed.coachId,
      resourceIds: [...new Set(slotResourceIds)],
      rows: inserted.map((r) => ({
        sessionId: r.id,
        resourceId: r.resourceId,
      })),
    },
  });

  return inserted;
}
