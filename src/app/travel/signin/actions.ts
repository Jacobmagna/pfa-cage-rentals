"use server";

import { headers } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";
import * as Sentry from "@sentry/nextjs";
import { signIn } from "@/travel/auth";
import { checkMagicLinkRateLimit } from "@/lib/ratelimit";

// Travel magic-link request flow. Mirrors the facility
// src/app/actions.ts:requestMagicLink, but drives the TRAVEL signIn and
// redirects back to /travel/signin on error. Reuses the shared rate-limit
// helper (a shared lib import — no shared file is modified).

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
