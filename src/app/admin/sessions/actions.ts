"use server";

// Admin-side public server actions for billing sessions. Thin authz
// wrappers around the internal logic in src/lib/server/session-actions.ts.
// Every async export in a "use server" file is exposed as a public
// RPC endpoint, so this file deliberately ONLY exposes the
// requireRole-gated paths.

import { requireRole } from "@/lib/authz";
import {
  createSessionInternal,
  deleteSessionInternal,
  updateSessionInternal,
} from "@/lib/server/session-actions";

export async function createSession(input: unknown) {
  const session = await requireRole("admin");
  return createSessionInternal(session.user, input);
}

export async function updateSession(id: string, input: unknown) {
  const session = await requireRole("admin");
  return updateSessionInternal(session.user, id, input);
}

export async function deleteSession(id: string) {
  const session = await requireRole("admin");
  return deleteSessionInternal(session.user, id);
}
