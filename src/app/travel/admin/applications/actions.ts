"use server";

import { headers } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";
import * as Sentry from "@sentry/nextjs";
import { requireTravelAccess } from "@/travel/authz";
import { acceptApplication, declineApplication } from "@/travel/applications";

// Operator review actions for /travel/admin/applications. Each re-checks
// requireTravelAccess() (defense-in-depth — a server action is its own entry
// point, not protected by the page guard). Both degrade to a ?error banner on a
// real failure and always redirect back to the pending tab.
//
// origin is computed from request headers (proto + host) so acceptApplication
// can build an absolute claim link in the onboarding email.

async function getOrigin(): Promise<string> {
  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "https";
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  return `${proto}://${host}`;
}

export async function acceptAction(formData: FormData): Promise<void> {
  await requireTravelAccess();

  const id = formData.get("id")?.toString().trim();
  if (!id) redirect("/travel/admin/applications?status=pending&error=1");

  try {
    const origin = await getOrigin();
    const result = await acceptApplication(id, origin);
    if (!result.ok) {
      redirect(
        `/travel/admin/applications?status=pending&error=${result.reason}`,
      );
    }
  } catch (err) {
    // The redirect above throws NEXT_REDIRECT — let framework errors propagate.
    unstable_rethrow(err);
    Sentry.captureException(err, {
      tags: { area: "travel-application-accept" },
      extra: { id },
    });
    redirect("/travel/admin/applications?status=pending&error=1");
  }

  redirect("/travel/admin/applications?status=pending&accepted=1");
}

export async function declineAction(formData: FormData): Promise<void> {
  await requireTravelAccess();

  const id = formData.get("id")?.toString().trim();
  if (!id) redirect("/travel/admin/applications?status=pending&error=1");

  const noteRaw = formData.get("note")?.toString().trim();
  const note = noteRaw ? noteRaw : null;

  try {
    await declineApplication(id, note);
  } catch (err) {
    unstable_rethrow(err);
    Sentry.captureException(err, {
      tags: { area: "travel-application-decline" },
      extra: { id },
    });
    redirect("/travel/admin/applications?status=pending&error=1");
  }

  redirect("/travel/admin/applications?status=pending&declined=1");
}
