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
import {
  deleteRateOverrideInternal,
  upsertRateOverrideInternal,
} from "@/lib/server/rate-override-actions";

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

export async function deleteRateOverride(input: unknown) {
  const session = await requireRole("admin");
  await deleteRateOverrideInternal(session.user, input);
  // input is unknown post-parse; the internal already validated. For
  // revalidation we pull coachId out at the boundary — duplicate
  // parse is cheap and keeps this function's authz layer honest.
  if (
    typeof input === "object" &&
    input !== null &&
    "coachId" in input &&
    typeof (input as { coachId: unknown }).coachId === "string"
  ) {
    revalidateOverrideSurfaces((input as { coachId: string }).coachId);
  }
}
