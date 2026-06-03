"use server";

// Public server actions for per-coach rate overrides. Thin authz
// wrappers around src/lib/server/rate-override-actions.ts. Every
// async export here is exposed as a public RPC endpoint, so this
// file deliberately ONLY exposes the requireRole("admin")-gated
// paths.
//
// Revalidation invariant: both mutations revalidate the coach detail
// page (so the override list re-renders) AND /admin/coaches (so the
// list page's "owed this month" recomputes against the new rate).
// Direct callers get correct behavior; form-action wrappers don't
// double-revalidate.

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/authz";
import type { ResourceType } from "@/lib/billing";
import {
  deleteRateOverrideInternal,
  upsertRateOverrideInternal,
} from "@/lib/server/rate-override-actions";
import {
  deleteProgramRateOverrideInternal,
  upsertProgramRateOverrideInternal,
} from "@/lib/server/program-rate-override-actions";
import { deleteCoachInternal } from "@/lib/server/user-actions";
import { updateUserHandlesInternal } from "@/lib/server/handles-actions";

function revalidateOverrideSurfaces(coachId: string) {
  revalidatePath(`/admin/coaches/${coachId}`);
  revalidatePath("/admin/coaches");
  // /admin/reports rate column also derives from overrides — but it's
  // a fully-dynamic searchParams page, no stale cache to bust.
}

export async function upsertRateOverride(input: unknown) {
  const session = await requireRole("admin");
  const result = await upsertRateOverrideInternal(session.user, input);
  revalidateOverrideSurfaces(result.coachId);
  return result;
}

// Explicit args (matches deleteSession(id) / deleteBlock(id) convention).
// The internal still Zod-parses for defense-in-depth.
export async function deleteRateOverride(
  coachId: string,
  resourceType: ResourceType,
) {
  const session = await requireRole("admin");
  await deleteRateOverrideInternal(session.user, { coachId, resourceType });
  revalidateOverrideSurfaces(coachId);
}

// Per-coach PROGRAM rate overrides. Mirrors the resource-type override
// actions above but keyed on (coachId, programId). Both revalidate the
// coach detail page so the program-rate card re-renders.
export async function upsertProgramRateOverride(input: unknown) {
  const session = await requireRole("admin");
  const result = await upsertProgramRateOverrideInternal(session.user, input);
  revalidateOverrideSurfaces(result.coachId);
  return result;
}

// Explicit args (matches deleteRateOverride convention). The internal
// still Zod-parses for defense-in-depth.
export async function deleteProgramRateOverride(
  coachId: string,
  programId: string,
) {
  const session = await requireRole("admin");
  await deleteProgramRateOverrideInternal(session.user, {
    coachId,
    programId,
  });
  revalidateOverrideSurfaces(coachId);
}

// Update Venmo + Zelle handles for a coach. Revalidates the coach
// detail page (so the chip on the handles card re-renders) and
// /admin/payments (so the reconciliation hints there pick up the
// change). No revalidate on /admin/coaches — that page doesn't show
// handles.
export async function updateCoachHandles(input: unknown) {
  const session = await requireRole("admin");
  const result = await updateUserHandlesInternal(session.user, input);
  revalidatePath(`/admin/coaches/${result.id}`);
  revalidatePath("/admin/payments");
  return result;
}

// J9 account deletion. Soft-delete + anonymize. See
// src/lib/server/user-actions.ts for the shape; this wrapper just
// gates with requireRole and revalidates every surface that lists
// active coaches.
export async function deleteCoach(coachId: string) {
  const session = await requireRole("admin");
  await deleteCoachInternal(session.user, { coachId });
  revalidatePath(`/admin/coaches/${coachId}`);
  revalidatePath("/admin/coaches");
  revalidatePath("/admin/sessions");
  revalidatePath("/admin/schedule");
  revalidatePath("/admin/reports");
  revalidatePath("/admin/audit");
}
