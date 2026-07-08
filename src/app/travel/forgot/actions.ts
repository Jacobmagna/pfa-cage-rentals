"use server";

import { headers } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";
import * as Sentry from "@sentry/nextjs";
import { requestPasswordReset } from "@/travel/auth-flow";
import { checkMagicLinkRateLimit } from "@/lib/ratelimit";

// Travel password-reset REQUEST action. NON-ENUMERATING: requestPasswordReset
// always resolves (a link is only sent when a claimed guardian exists), and
// this action ALWAYS redirects to ?sent=1 with the same copy regardless — so
// nothing about it reveals whether the email has an account.

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

export async function requestTravelReset(formData: FormData): Promise<void> {
  const email = formData.get("email")?.toString().trim();
  // No-enumeration: even a missing/blank email lands on the same confirmation.
  if (!email) redirect("/travel/forgot?sent=1");

  const ip = await getClientIp();
  const decision = await checkMagicLinkRateLimit(email, ip);
  if (!decision.allowed) {
    redirect(`/travel/forgot?error=${decision.reason}`);
  }

  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "https";
  const host = h.get("host") ?? "";
  const origin = `${proto}://${host}`;

  try {
    await requestPasswordReset(email, origin);
  } catch (err) {
    unstable_rethrow(err);
    // Swallow real send failures into the same generic confirmation (no leak),
    // but capture for observability.
    Sentry.captureException(err, {
      tags: { area: "travel-reset-request" },
      extra: { email },
    });
  }

  redirect("/travel/forgot?sent=1");
}
