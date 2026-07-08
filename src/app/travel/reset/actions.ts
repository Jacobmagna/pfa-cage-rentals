"use server";

import { redirect, unstable_rethrow } from "next/navigation";
import * as Sentry from "@sentry/nextjs";
import { resetPassword } from "@/travel/auth-flow";

// Travel password-RESET action. Consumes the reset token + sets the new
// password (resetPassword also invalidates all existing guardian sessions).
// Does NOT auto-login — on success it sends the parent to /travel/signin?reset=1
// where the "sign in with your new password" banner shows. Errors round-trip to
// /travel/reset?error=<code> (preserving email + token so the form re-posts).

export async function resetTravelPassword(formData: FormData): Promise<void> {
  const email = formData.get("email")?.toString() ?? "";
  const token = formData.get("token")?.toString() ?? "";
  const password = formData.get("password")?.toString() ?? "";
  const confirm = formData.get("confirm")?.toString() ?? "";

  const qs = new URLSearchParams({ email, token });

  if (password !== confirm) {
    qs.set("error", "mismatch");
    redirect(`/travel/reset?${qs.toString()}`);
  }

  try {
    const r = await resetPassword(email, token, password);
    if (r.ok) redirect("/travel/signin?reset=1");
    qs.set("error", r.code);
    redirect(`/travel/reset?${qs.toString()}`);
  } catch (err) {
    unstable_rethrow(err);
    Sentry.captureException(err, {
      tags: { area: "travel-reset" },
      extra: { email },
    });
    qs.set("error", "bad_token");
    redirect(`/travel/reset?${qs.toString()}`);
  }
}
