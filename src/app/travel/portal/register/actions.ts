"use server";

import { headers } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";
import * as Sentry from "@sentry/nextjs";
import { checkMagicLinkRateLimit } from "@/lib/ratelimit";
import { requireTravelGuardian } from "@/travel/authz";
import { registerTravelAthleteForProduct } from "@/travel/registration";

// Block 3c — the parent registration server action. A signed-in travel GUARDIAN
// registers one of their OWN rostered athletes for a registerable product
// (season/team dues, camp, clinic, program) by calling the Block-3b engine.
//
// Structure mirrors src/app/travel/apply/actions.ts: getClientIp (copied so no
// shared file is touched), a rate-limit gate BEFORE any DB work, ?error=<code>
// banner redirects on failure, and unstable_rethrow → Sentry on an unexpected
// throw. Success routes to ?done=1&amt=<totalCents> (the page formats it).
//
// The client NEVER sends a price — only ids + an optional tierKey; the engine
// re-resolves the tier's priceCents server-side (the money-correctness boundary).

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

// Normalize an optional text field: trimmed, or null if blank.
function optional(value: FormDataEntryValue | null): string | null {
  const s = value?.toString().trim();
  return s ? s : null;
}

export async function submitRegistration(formData: FormData): Promise<void> {
  // Guardian-only: a non-guardian (admin / no session) is bounced to sign-in,
  // exactly as the portal page is. requireTravelGuardian redirects internally.
  const guardian = await requireTravelGuardian();

  // Rate-limit on (guardianId, IP) BEFORE any DB work — same shared cap the
  // magic-link surfaces use. Keyed on the guardian id (a stable session subject).
  const ip = await getClientIp();
  const decision = await checkMagicLinkRateLimit(guardian.id, ip);
  if (!decision.allowed) {
    redirect("/travel/portal/register?error=rate");
  }

  const athleteId = optional(formData.get("athleteId"));
  const productId = optional(formData.get("productId"));
  const tierKey = optional(formData.get("tierKey"));

  if (!athleteId || !productId) {
    redirect("/travel/portal/register?error=missing");
  }

  let result: Awaited<ReturnType<typeof registerTravelAthleteForProduct>>;
  try {
    result = await registerTravelAthleteForProduct({
      guardianId: guardian.id,
      athleteId,
      productId,
      tierKey,
    });
  } catch (err) {
    // The redirects in THIS function throw NEXT_REDIRECT — let framework errors
    // propagate untouched before treating anything as a real failure.
    unstable_rethrow(err);

    Sentry.captureException(err, {
      tags: { area: "travel-registration-submit" },
      extra: { guardianId: guardian.id, productId },
    });
    redirect("/travel/portal/register?error=missing");
  }

  if (!result.ok) {
    // Map the engine's typed error straight onto a friendly banner code. Every
    // RegisterResult error string is a valid ?error= code the page renders.
    redirect(`/travel/portal/register?error=${result.error}`);
  }

  // Success: pass only the amount owed through the redirect (the page formats it
  // for the confirmation card). The invoiceId stays server-side — amt is enough.
  redirect(`/travel/portal/register?done=1&amt=${result.totalCents}`);
}
