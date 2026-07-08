"use server";

import { redirect, unstable_rethrow } from "next/navigation";
import * as Sentry from "@sentry/nextjs";
import { claimAndSetPassword } from "@/travel/auth-flow";

// Travel account-claim action. Consumes the setup (claim) token + sets the
// parent's first password, then logs them into the portal. claimAndSetPassword
// mints the guardian session cookie on success. Errors round-trip back to
// /travel/claim?error=<code> (preserving email + token so the form still posts
// correctly). NO enumeration surfaces here — a bad/expired token is generic.

export async function claimTravelAccount(formData: FormData): Promise<void> {
  const email = formData.get("email")?.toString() ?? "";
  const token = formData.get("token")?.toString() ?? "";
  const password = formData.get("password")?.toString() ?? "";
  const confirm = formData.get("confirm")?.toString() ?? "";

  const qs = new URLSearchParams({ email, token });

  if (password !== confirm) {
    qs.set("error", "mismatch");
    redirect(`/travel/claim?${qs.toString()}`);
  }

  try {
    const r = await claimAndSetPassword(email, token, password);
    if (r.ok) redirect("/travel/portal");
    qs.set("error", r.code);
    redirect(`/travel/claim?${qs.toString()}`);
  } catch (err) {
    unstable_rethrow(err);
    Sentry.captureException(err, {
      tags: { area: "travel-claim" },
      extra: { email },
    });
    qs.set("error", "bad_token");
    redirect(`/travel/claim?${qs.toString()}`);
  }
}
