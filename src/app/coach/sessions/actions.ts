"use server";

// Coach-side public server actions for billing sessions. Thin
// authz wrappers around the internal logic in
// src/lib/server/session-actions.ts.
//
// Every async export in a "use server" file is exposed as a public
// RPC endpoint. Every entry point here is gated by requireSession()
// and either force-overrides coachId to the authed user's id
// (create / update) or runs requireSessionOwnership against the
// existing row (update / delete). A coach cannot create a session
// for another coach and cannot edit or delete a row they don't own.
// Admins always pass requireSessionOwnership so they can use these
// to manage their own sessions if they happen to coach too — but
// for cross-coach admin work they should use /admin/sessions.
//
// Each mutation calls revalidatePath at the end so any direct RPC
// caller (not just our form-action wrappers) gets fresh data on
// /coach and /coach/sessions. The form-action wrappers also call
// revalidatePath — the duplication is cheap and the invariant
// ("every public server action that mutates revalidates") is the
// thing that matters.

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { sessionsBilling } from "@/db/schema";
import { requireSession, requireSessionOwnership } from "@/lib/authz";
import { PastRentalImmutableError, SessionNotFoundError } from "@/lib/errors";
import {
  createSessionInternal,
  createSessionsBatchInternal,
  deleteSessionInternal,
  updateSessionInternal,
} from "@/lib/server/session-actions";
import { requestSessionRemovalInternal } from "@/lib/server/session-removal-actions";

function revalidateCoachSurfaces() {
  revalidatePath("/coach");
  revalidatePath("/coach/sessions");
  // 1b #26/27: a coach cancelling a rental updates the admin cancellations
  // dashboard (now folded under the coach accountability scorecard; records a
  // session_cancellations row on delete).
  revalidatePath("/admin/cage-rentals");
  revalidatePath("/admin/records/accountability/cancellations");
  // 1b security: a coach filing a removal request feeds the admin queue.
  revalidatePath("/admin/sessions/removal-requests");
}

export async function logOwnSession(input: unknown) {
  const session = await requireSession();
  const base =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};
  // Force coachId server-side — client-supplied coachId is discarded.
  const safeInput = { ...base, coachId: session.user.id };
  const result = await createSessionInternal(session.user, safeInput);
  revalidateCoachSurfaces();
  return result;
}

export async function logOwnSessionsBatch(input: unknown) {
  const session = await requireSession();
  const base =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};
  // Same coachId-forcing as logOwnSession — client can't impersonate.
  const safeInput = { ...base, coachId: session.user.id };
  const result = await createSessionsBatchInternal(session.user, safeInput);
  revalidateCoachSurfaces();
  return result;
}

export async function updateOwnSession(id: string, input: unknown) {
  const session = await requireSession();
  const [existing] = await db
    .select({
      id: sessionsBilling.id,
      coachId: sessionsBilling.coachId,
      resourceId: sessionsBilling.resourceId,
      startAt: sessionsBilling.startAt,
      endAt: sessionsBilling.endAt,
    })
    .from(sessionsBilling)
    .where(eq(sessionsBilling.id, id))
    .limit(1);
  if (!existing) throw new SessionNotFoundError(id);
  // Redirects to /coach if the row isn't owned by this user (admins pass).
  requireSessionOwnership(existing, session.user);
  const base =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};
  // Force coachId — coach can't reassign a session to another coach.
  const safeInput = { ...base, coachId: session.user.id };

  // 1b security: a coach can't edit a BILLABLE field (resource/date/
  // start/end) of a PAST rental — only the note. Admins bypass (they
  // use the /admin path). The server is the source of truth here; the
  // coach UI mirrors it by disabling those inputs.
  if (session.user.role === "coach" && existing.startAt <= new Date()) {
    const incoming = parseBillableFields(safeInput);
    const billableChanged =
      (incoming.resourceId !== undefined &&
        incoming.resourceId !== existing.resourceId) ||
      (incoming.startAt !== undefined &&
        incoming.startAt.getTime() !== existing.startAt.getTime()) ||
      (incoming.endAt !== undefined &&
        incoming.endAt.getTime() !== existing.endAt.getTime());
    if (billableChanged) throw new PastRentalImmutableError(id);
  }

  const result = await updateSessionInternal(session.user, id, safeInput);
  revalidateCoachSurfaces();
  return result;
}

// Parse the billable fields off a raw update input for the past-rental
// guard. Tolerant of missing/ill-typed values — the canonical Zod parse
// happens inside updateSessionInternal; here we only need to detect a
// billable CHANGE vs the existing row.
function parseBillableFields(input: Record<string, unknown>): {
  resourceId?: string;
  startAt?: Date;
  endAt?: Date;
} {
  const out: { resourceId?: string; startAt?: Date; endAt?: Date } = {};
  if (typeof input.resourceId === "string") out.resourceId = input.resourceId;
  const start = coerceDate(input.startAt);
  if (start) out.startAt = start;
  const end = coerceDate(input.endAt);
  if (end) out.endAt = end;
  return out;
}

function coerceDate(v: unknown): Date | undefined {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : v;
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}

export async function deleteOwnSession(id: string) {
  const session = await requireSession();
  const [existing] = await db
    .select({
      id: sessionsBilling.id,
      coachId: sessionsBilling.coachId,
      startAt: sessionsBilling.startAt,
    })
    .from(sessionsBilling)
    .where(eq(sessionsBilling.id, id))
    .limit(1);
  if (!existing) throw new SessionNotFoundError(id);
  requireSessionOwnership(existing, session.user);

  // 1b security: a coach can't hard-delete a PAST rental (a charge they
  // owe PFA) — they must file an admin-approved removal request instead.
  // Future rentals: unchanged. Admins bypass (they use the /admin path).
  if (session.user.role === "coach" && existing.startAt <= new Date()) {
    throw new PastRentalImmutableError(id);
  }

  const result = await deleteSessionInternal(session.user, id);
  revalidateCoachSurfaces();
  return result;
}

// 1b security: a coach files a removal request for a PAST rental. Gated
// by requireSession + ownership of the existing row; the internal logic
// re-verifies ownership + that the rental is actually past.
export async function requestOwnSessionRemoval(
  sessionId: string,
  reason?: string | null,
) {
  const session = await requireSession();
  const [existing] = await db
    .select({ id: sessionsBilling.id, coachId: sessionsBilling.coachId })
    .from(sessionsBilling)
    .where(eq(sessionsBilling.id, sessionId))
    .limit(1);
  if (!existing) throw new SessionNotFoundError(sessionId);
  requireSessionOwnership(existing, session.user);
  const result = await requestSessionRemovalInternal(session.user, {
    sessionId,
    reason: reason ?? null,
  });
  revalidateCoachSurfaces();
  return result;
}
