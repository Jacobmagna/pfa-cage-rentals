// 1b security — past cage-rental removal requests.
//
// A cage rental is money the coach OWES PFA, so a coach must NOT be
// able to erase a PAST charge unilaterally. Future rentals: the coach
// still cancels/edits freely (today's behavior, recorded by #26/27).
// Past/started rentals (startAt <= now): the coach instead files a
// "didn't happen — request removal" that an ADMIN approves (which
// hard-deletes the rental via the existing deleteSessionInternal — that
// records the #26/27 session_cancellations row with cancelledBy=admin)
// or denies. Admins always retain direct delete/edit.
//
// Like session-actions.ts these internals take the `actor` as a
// parameter, so they live OUTSIDE any "use server" file (exposing them
// would let a caller forge an identity). Public wrappers gate them with
// requireSession (coach request) / requireRole("admin") (approve/deny).
//
// Atomicity: neon-http is stateless HTTP and has no transactions. On
// approve we mark the request approved FIRST, then delete the session.
// If the session is already gone (SessionNotFoundError — e.g. an admin
// deleted it directly), we swallow that and keep the request approved,
// so approve is idempotent.

import { and, desc, eq } from "drizzle-orm";
import * as Sentry from "@sentry/nextjs";
import { db } from "@/db";
import {
  resources,
  sessionRemovalRequests,
  sessionsBilling,
  users,
} from "@/db/schema";
import { logAudit } from "@/lib/audit";
import type { AuthedSession } from "@/lib/authz";
import {
  PastRentalImmutableError,
  RemovalRequestExistsError,
  RemovalRequestNotFoundError,
  SessionNotFoundError,
} from "@/lib/errors";
import {
  requestRemovalSchema,
  resolveRemovalSchema,
} from "@/lib/schemas/session";
import { deleteSessionInternal } from "@/lib/server/session-actions";

// Audit-log insert wrapper that swallows failures rather than letting an
// audit hiccup mask a successful mutation (which we can't roll back under
// neon-http anyway). Sentry captures so we know. Mirrors session-actions.ts.
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

// Coach files a removal request for a PAST rental. Ownership is enforced
// in the public wrapper; we ALSO verify here (defense in depth) that a
// coach actor owns the rental.
export async function requestSessionRemovalInternal(
  actor: AuthedSession["user"],
  rawInput: unknown,
) {
  const parsed = requestRemovalSchema.parse(rawInput);

  const [existing] = await db
    .select()
    .from(sessionsBilling)
    .where(eq(sessionsBilling.id, parsed.sessionId))
    .limit(1);
  if (!existing) throw new SessionNotFoundError(parsed.sessionId);

  // Defense in depth: a coach can only request removal of their own
  // rental. Admins (who'd just delete directly) bypass the ownership
  // check here.
  if (actor.role === "coach" && existing.coachId !== actor.id) {
    throw new SessionNotFoundError(parsed.sessionId);
  }

  // Future rentals use the normal delete/edit path — there's nothing to
  // gate, so a removal request is meaningless for them.
  if (existing.startAt > new Date()) {
    throw new PastRentalImmutableError(parsed.sessionId);
  }

  // One open request per session.
  const [pending] = await db
    .select({ id: sessionRemovalRequests.id })
    .from(sessionRemovalRequests)
    .where(
      and(
        eq(sessionRemovalRequests.sessionId, parsed.sessionId),
        eq(sessionRemovalRequests.status, "pending"),
      ),
    )
    .limit(1);
  if (pending) throw new RemovalRequestExistsError(parsed.sessionId);

  const [inserted] = await db
    .insert(sessionRemovalRequests)
    .values({
      sessionId: existing.id,
      coachId: existing.coachId,
      resourceId: existing.resourceId,
      startAt: existing.startAt,
      endAt: existing.endAt,
      ratePer30MinCents: existing.ratePer30MinCents,
      reason: parsed.reason ?? null,
      status: "pending",
      requestedBy: actor.id,
    })
    .returning();

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "session_removal_request",
    entityId: inserted.id,
    action: "create",
    after: inserted as unknown as Record<string, unknown>,
  });

  return inserted;
}

// Admin approves a removal request: mark approved FIRST, then delete the
// session. deleteSessionInternal records the #26/27 cancellation with
// cancelledBy=actor (admin) — we do NOT duplicate that. If the session
// is already gone, swallow SessionNotFoundError and keep the request
// approved (idempotent under neon-http's no-transaction model).
export async function approveSessionRemovalInternal(
  actor: AuthedSession["user"],
  rawInput: unknown,
) {
  const parsed = resolveRemovalSchema.parse(rawInput);

  const [request] = await db
    .select()
    .from(sessionRemovalRequests)
    .where(eq(sessionRemovalRequests.id, parsed.requestId))
    .limit(1);
  if (!request || request.status !== "pending") {
    throw new RemovalRequestNotFoundError(parsed.requestId);
  }

  const [updated] = await db
    .update(sessionRemovalRequests)
    .set({
      status: "approved",
      resolvedAt: new Date(),
      resolvedBy: actor.id,
    })
    .where(eq(sessionRemovalRequests.id, parsed.requestId))
    .returning();

  // Delete the underlying rental. This is the SINGLE delete point that
  // also records the #26/27 cancellation (cancelledBy=admin). If the
  // session was already removed (e.g. admin deleted it directly), swallow
  // and keep the request approved.
  try {
    await deleteSessionInternal(actor, request.sessionId);
  } catch (err) {
    if (!(err instanceof SessionNotFoundError)) throw err;
  }

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "session_removal_request",
    entityId: request.id,
    action: "update",
    before: request as unknown as Record<string, unknown>,
    after: updated as unknown as Record<string, unknown>,
  });

  return updated;
}

// Admin denies a removal request: mark denied with an optional note. The
// session stays — nothing else changes.
export async function denySessionRemovalInternal(
  actor: AuthedSession["user"],
  rawInput: unknown,
) {
  const parsed = resolveRemovalSchema.parse(rawInput);

  const [request] = await db
    .select()
    .from(sessionRemovalRequests)
    .where(eq(sessionRemovalRequests.id, parsed.requestId))
    .limit(1);
  if (!request || request.status !== "pending") {
    throw new RemovalRequestNotFoundError(parsed.requestId);
  }

  const [updated] = await db
    .update(sessionRemovalRequests)
    .set({
      status: "denied",
      resolvedAt: new Date(),
      resolvedBy: actor.id,
      adminNote: parsed.adminNote ?? null,
    })
    .where(eq(sessionRemovalRequests.id, parsed.requestId))
    .returning();

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "session_removal_request",
    entityId: request.id,
    action: "update",
    before: request as unknown as Record<string, unknown>,
    after: updated as unknown as Record<string, unknown>,
  });

  return updated;
}

export type PendingRemovalRequest = {
  id: string;
  sessionId: string;
  coachId: string;
  coachName: string | null;
  resourceName: string | null;
  startAt: Date;
  endAt: Date;
  ratePer30MinCents: number | null;
  reason: string | null;
  requestedAt: Date;
};

// Pending requests joined to coach + resource names, newest-first. Drives
// the admin removal-requests queue.
export async function loadPendingRemovalRequests(): Promise<
  PendingRemovalRequest[]
> {
  const rows = await db
    .select({
      id: sessionRemovalRequests.id,
      sessionId: sessionRemovalRequests.sessionId,
      coachId: sessionRemovalRequests.coachId,
      coachName: users.name,
      resourceName: resources.name,
      startAt: sessionRemovalRequests.startAt,
      endAt: sessionRemovalRequests.endAt,
      ratePer30MinCents: sessionRemovalRequests.ratePer30MinCents,
      reason: sessionRemovalRequests.reason,
      requestedAt: sessionRemovalRequests.requestedAt,
    })
    .from(sessionRemovalRequests)
    .leftJoin(users, eq(users.id, sessionRemovalRequests.coachId))
    .leftJoin(resources, eq(resources.id, sessionRemovalRequests.resourceId))
    .where(eq(sessionRemovalRequests.status, "pending"))
    .orderBy(desc(sessionRemovalRequests.requestedAt));

  return rows;
}

// Count of pending removal requests — for the admin hub stat.
export async function countPendingRemovalRequests(): Promise<number> {
  const rows = await db
    .select({ id: sessionRemovalRequests.id })
    .from(sessionRemovalRequests)
    .where(eq(sessionRemovalRequests.status, "pending"));
  return rows.length;
}

// Session ids with a PENDING removal request for one coach — so the
// coach's rental list can mark those rows "removal requested".
export async function pendingRemovalSessionIds(
  coachId: string,
): Promise<Set<string>> {
  const rows = await db
    .select({ sessionId: sessionRemovalRequests.sessionId })
    .from(sessionRemovalRequests)
    .where(
      and(
        eq(sessionRemovalRequests.coachId, coachId),
        eq(sessionRemovalRequests.status, "pending"),
      ),
    );
  return new Set(rows.map((r) => r.sessionId));
}
