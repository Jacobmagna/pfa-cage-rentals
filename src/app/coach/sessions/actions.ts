"use server";

// Coach-side public server actions for billing sessions. Thin
// authz wrappers around the internal logic in
// src/lib/server/session-actions.ts.
//
// Every async export in a "use server" file is exposed as a public
// RPC endpoint. The wrappers here gate every entry point with
// requireSession() AND force-override coachId to the authed user's
// id — so a client can't spoof another coach's id in the form data.
// Admins who happen to load /coach/sessions/new will log a session
// for themselves; they should use /admin/sessions when entering on
// someone else's behalf.

import { requireSession } from "@/lib/authz";
import { createSessionInternal } from "@/lib/server/session-actions";

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
