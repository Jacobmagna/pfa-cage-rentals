"use server";

// Public server actions for /admin/settings. Currently just org-wide
// PFA payment handles (Phase P3) — keeping the file separate from
// other admin actions because the surface is likely to grow (default
// rates, theme, slack webhook, etc.) and merging now would clutter
// existing files.

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/authz";
import { updateOrgSettingsInternal } from "@/lib/server/handles-actions";
import { updateRateDefaultsInternal } from "@/lib/server/rate-defaults-actions";

export async function updateOrgSettings(input: unknown) {
  const session = await requireRole("admin");
  const result = await updateOrgSettingsInternal(session.user, input);
  revalidatePath("/admin/settings");
  // P4's /coach/payments will deep-link to these handles, so bust
  // the coach surface too once it ships. Harmless to revalidate now —
  // a non-existent route revalidate is a no-op in Next.
  revalidatePath("/coach/payments");
  return result;
}

export async function updateRateDefaults(input: unknown) {
  const session = await requireRole("admin");
  await updateRateDefaultsInternal(session.user, input);
  revalidatePath("/admin/settings");
}
