"use server";

import { headers } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";
import * as Sentry from "@sentry/nextjs";
import { signIn } from "@/travel/auth";
import { signInWithPassword } from "@/travel/auth-flow";
import { checkMagicLinkRateLimit } from "@/lib/ratelimit";

// Travel sign-in server actions.
//
//   • requestTravelMagicLink — the ADMIN magic-link flow. Mirrors the facility
//     src/app/actions.ts:requestMagicLink, but drives the TRAVEL signIn and
//     redirects back to /travel/signin on error.
//   • signInTravelParent — the PARENT email+password flow. Calls the already
//     built signInWithPassword (which mints the guardian session cookie on
//     success), then redirects to the parent portal. Parent errors use a
//     DISTINCT `?perror` param so they never collide with the magic-link copy.
//
// Both reuse the shared rate-limit helper (a shared lib import — no shared file
// is modified).

async function getClientIp(): Promise<string> {
  const h = await headers();
  const vercel = h.get("x-vercel-forwarded-for");
  if (vercel) return vercel.split(",")[0]!.trim();
  const real = h.get("x-real-ip");
  if (real) return real.trim();
  const forwarded = h.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return "unknown";
}

export async function requestTravelMagicLink(formData: FormData): Promise<void> {
  const email = formData.get("email")?.toString().trim();
  if (!email) redirect("/travel/signin?error=missing-email");

  const ip = await getClientIp();
  const decision = await checkMagicLinkRateLimit(email, ip);
  if (!decision.allowed) {
    redirect(`/travel/signin?error=${decision.reason}`);
  }

  // On SUCCESS, signIn throws NEXT_REDIRECT — that control-flow throw MUST
  // propagate untouched. unstable_rethrow re-throws framework errors first;
  // only a REAL send failure degrades to the graceful ?error banner.
  try {
    await signIn("resend", { email, redirectTo: "/travel" });
  } catch (err) {
    unstable_rethrow(err);
    Sentry.captureException(err, {
      tags: { area: "travel-magic-link-send" },
      extra: { email },
    });
    redirect("/travel/signin?error=send-failed");
  }
}

export async function signInTravelParent(formData: FormData): Promise<void> {
  const email = formData.get("email")?.toString().trim();
  const password = formData.get("password")?.toString() ?? "";
  if (!email) redirect("/travel/signin?perror=invalid");

  const ip = await getClientIp();
  const decision = await checkMagicLinkRateLimit(email, ip);
  if (!decision.allowed) {
    // Rate-limit surfaces on the magic-link banner (shared cap for this email
    // + IP); parent errors otherwise use ?perror.
    redirect(`/travel/signin?error=${decision.reason}`);
  }

  // signInWithPassword mints the guardian session cookie on success; the
  // redirect below is the only thing this action adds. On failure it returns a
  // FlowResult code we map to a parent-scoped ?perror banner.
  try {
    const r = await signInWithPassword(email, password);
    if (r.ok) redirect("/travel/portal");
    redirect(`/travel/signin?perror=${r.code}`);
  } catch (err) {
    // The redirects above throw NEXT_REDIRECT — let those propagate untouched.
    unstable_rethrow(err);
    Sentry.captureException(err, {
      tags: { area: "travel-parent-signin" },
      extra: { email },
    });
    redirect("/travel/signin?perror=invalid");
  }
}
