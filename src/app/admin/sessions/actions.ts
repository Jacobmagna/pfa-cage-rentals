"use server";

// Admin-side public server actions for billing sessions. Thin authz
// wrappers around the internal logic in src/lib/server/session-actions.ts.
// Every async export in a "use server" file is exposed as a public
// RPC endpoint, so this file deliberately ONLY exposes the
// requireRole-gated paths.
//
// Revalidation invariant: every public action that mutates revalidates
// the two surfaces that render sessions (/admin/schedule + /admin/sessions).
// Form-action wrappers no longer double-revalidate. Direct callers
// (e.g. the grid's drag-to-move) get the right behavior for free —
// without this, a successful drag would only show up after the next
// 30s AutoRefresh tick.

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/authz";
import {
  createSessionInternal,
  createSessionsBatchInternal,
  deleteSessionInternal,
  updateSessionInternal,
} from "@/lib/server/session-actions";
import {
  approveSessionRemovalInternal,
  denySessionRemovalInternal,
} from "@/lib/server/session-removal-actions";

function revalidateSessionSurfaces() {
  revalidatePath("/admin/schedule");
  revalidatePath("/admin/sessions");
  // 1b #26/27: an admin removing a rental updates the cancellations dashboard
  // (now folded under the coach accountability scorecard).
  revalidatePath("/admin/cage-rentals");
  revalidatePath("/admin/records/accountability/cancellations");
}

export async function createSession(input: unknown) {
  const session = await requireRole("admin");
  const result = await createSessionInternal(session.user, input);
  revalidateSessionSurfaces();
  return result;
}

export async function createSessionsBatch(input: unknown) {
  const session = await requireRole("admin");
  const result = await createSessionsBatchInternal(session.user, input);
  revalidateSessionSurfaces();
  return result;
}

export async function updateSession(id: string, input: unknown) {
  const session = await requireRole("admin");
  const result = await updateSessionInternal(session.user, id, input);
  revalidateSessionSurfaces();
  return result;
}

export async function deleteSession(id: string) {
  const session = await requireRole("admin");
  const result = await deleteSessionInternal(session.user, id);
  revalidateSessionSurfaces();
  return result;
}

// 1b security: surfaces touched when an admin resolves a coach's
// past-rental removal request — the queue, the session/rental views, the
// cancellations dashboard (approve records one), and the coach's list.
function revalidateRemovalSurfaces() {
  revalidatePath("/admin/sessions/removal-requests");
  revalidatePath("/admin/sessions");
  revalidatePath("/admin/cage-rentals");
  revalidatePath("/admin/records/accountability/cancellations");
  revalidatePath("/coach/sessions");
}

// 1b security: admin approves a coach's removal request — hard-deletes
// the rental (recording the #26/27 cancellation as admin) and marks the
// request approved.
export async function approveSessionRemoval(requestId: string) {
  const session = await requireRole("admin");
  const result = await approveSessionRemovalInternal(session.user, {
    requestId,
  });
  revalidateRemovalSurfaces();
  return result;
}

// 1b security: admin denies a coach's removal request — the rental
// stays; an optional note records why.
export async function denySessionRemoval(
  requestId: string,
  adminNote?: string | null,
) {
  const session = await requireRole("admin");
  const result = await denySessionRemovalInternal(session.user, {
    requestId,
    adminNote: adminNote ?? null,
  });
  revalidateRemovalSurfaces();
  return result;
}
