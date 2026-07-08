"use server";

import { redirect, unstable_rethrow } from "next/navigation";
import * as Sentry from "@sentry/nextjs";
import { requireTravelAccess } from "@/travel/authz";
import { setTravelProductActive } from "@/travel/catalog";

// Block 3d-1 — the archive/reactivate action for the product catalog list. Its
// own entry point, so it re-checks requireTravelAccess() (defense-in-depth: the
// page guard doesn't cover a server action). Failures degrade to a ?error=<code>
// banner; success routes back with ?saved=1.

export async function setProductActiveAction(
  formData: FormData,
): Promise<void> {
  await requireTravelAccess();

  const id = formData.get("id")?.toString().trim();
  // The desired state is passed explicitly ("true"/"false") so the same action
  // both archives and reactivates.
  const active = formData.get("active")?.toString() === "true";

  if (!id) redirect("/travel/admin/products?error=1");

  try {
    const result = await setTravelProductActive(id, active);
    if (!result.ok) {
      redirect(`/travel/admin/products?error=${result.error}`);
    }
  } catch (err) {
    // The redirects above throw NEXT_REDIRECT — let framework errors propagate.
    unstable_rethrow(err);
    Sentry.captureException(err, {
      tags: { area: "travel-product-set-active" },
      extra: { id, active },
    });
    redirect("/travel/admin/products?error=1");
  }

  redirect("/travel/admin/products?saved=1");
}
