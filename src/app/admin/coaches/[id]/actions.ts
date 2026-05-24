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
