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

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { sessionsBilling } from "@/db/schema";
import { requireSession, requireSessionOwnership } from "@/lib/authz";
import { SessionNotFoundError } from "@/lib/errors";
import {
  createSessionInternal,
  deleteSessionInternal,
  updateSessionInternal,
} from "@/lib/server/session-actions";

export async function logOwnSession(input: unknown) {
  const session = await requireSession();
  const base =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};
  // Force coachId server-side — client-supplied coachId is discarded.
  const safeInput = { ...base, coachId: session.user.id };
  return createSessionInternal(session.user, safeInput);
}

export async function updateOwnSession(id: string, input: unknown) {
  const session = await requireSession();
  const [existing] = await db
    .select({ id: sessionsBilling.id, coachId: sessionsBilling.coachId })
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
  return updateSessionInternal(session.user, id, safeInput);
}

export async function deleteOwnSession(id: string) {
  const session = await requireSession();
  const [existing] = await db
    .select({ id: sessionsBilling.id, coachId: sessionsBilling.coachId })
    .from(sessionsBilling)
    .where(eq(sessionsBilling.id, id))
    .limit(1);
  if (!existing) throw new SessionNotFoundError(id);
  requireSessionOwnership(existing, session.user);
  return deleteSessionInternal(session.user, id);
}
