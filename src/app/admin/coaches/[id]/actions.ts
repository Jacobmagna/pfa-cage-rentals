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
import {
  archiveCoachInternal,
  deleteCoachInternal,
} from "@/lib/server/user-actions";
import { updateUserHandlesInternal } from "@/lib/server/handles-actions";
import { updateCoachNotesInternal } from "@/lib/server/coach-notes-actions";
import { updateCoachPaySettingsInternal } from "@/lib/server/coach-pay-settings-actions";

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

// QA2 #8 — update the admin-only free-text notes on a coach. Revalidates
// the coach detail page so the Notes card re-renders with the saved text.
// Notes are never shown on coach-facing surfaces, so no other revalidate.
export async function updateCoachNotes(input: unknown) {
  const session = await requireRole("admin");
  const result = await updateCoachNotesInternal(session.user, input);
  revalidatePath(`/admin/coaches/${result.id}`);
  return result;
}

// QA2 #6 — set how FUTURE logged work is paid for this coach (hourly vs
// a flat per-session amount). Does NOT retroactively change already-logged
// work — the billing layer snapshots the basis at log time. Revalidates
// the coach detail page so the Work-pay-mode card re-renders.
export async function updateCoachPaySettings(input: unknown) {
  const session = await requireRole("admin");
  const result = await updateCoachPaySettingsInternal(session.user, input);
  revalidatePath(`/admin/coaches/${result.coachId}`);
  return result;
}

// #28 archive coach. REVERSIBLE soft-delete that PRESERVES name/email —
// this is what the danger-zone "Archive coach" card calls. Mirrors the
// revalidation set of deleteCoach / restoreCoach so the coach leaves the
// active surfaces and appears (with real identity) on /admin/coaches/archive.
export async function archiveCoach(coachId: string) {
  const session = await requireRole("admin");
  await archiveCoachInternal(session.user, coachId);
  revalidatePath(`/admin/coaches/${coachId}`);
  revalidatePath("/admin/coaches");
  revalidatePath("/admin/coaches/archive");
  revalidatePath("/admin/sessions");
  revalidatePath("/admin/schedule");
  revalidatePath("/admin/reports");
  revalidatePath("/admin/audit");
}

// J9 account deletion (GDPR / "remove my info"). Soft-delete + ANONYMIZE.
// See src/lib/server/user-actions.ts for the shape; this wrapper gates
// with requireRole and revalidates every surface that lists active
// coaches. No longer wired to the interactive UI (the Archive card now
// uses the non-anonymizing archiveCoach above) — kept exported for the
// privacy-erasure path / scripts.
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
