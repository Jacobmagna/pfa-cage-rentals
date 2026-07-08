"use server";

import { headers } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";
import * as Sentry from "@sentry/nextjs";
import { checkMagicLinkRateLimit } from "@/lib/ratelimit";
import {
  createApplication,
  type CreateApplicationError,
} from "@/travel/applications";

// Public "Request to Join / Tryout" server action. No auth. Rate-limited on
// (parentEmail, IP) via the shared magic-link limiter, then writes a pending
// travel_applications row. Errors degrade to ?error=<code> banners; success
// redirects to ?submitted=1 (the page swaps to a confirmation state).
//
// getClientIp mirrors src/app/travel/signin/actions.ts (copied so no shared
// file is modified).

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

export async function submitApplication(formData: FormData): Promise<void> {
  const teamId = optional(formData.get("teamId"));
  const parentEmail = formData.get("parentEmail")?.toString().trim() ?? "";

  // Preserve the chosen team across an error redirect so the family doesn't
  // lose their selection. Encoded so an arbitrary id can't break the URL.
  const teamQuery = teamId ? `&team=${encodeURIComponent(teamId)}` : "";

  // Rate-limit on (email, IP) BEFORE any DB work — same shared cap as sign-in.
  const ip = await getClientIp();
  const decision = await checkMagicLinkRateLimit(parentEmail || "unknown", ip);
  if (!decision.allowed) {
    redirect(`/travel/apply?error=rate${teamQuery}`);
  }

  const gradYearRaw = optional(formData.get("athleteGradYear"));
  const gradYearParsed = gradYearRaw ? Number.parseInt(gradYearRaw, 10) : NaN;
  const athleteGradYear = Number.isFinite(gradYearParsed)
    ? gradYearParsed
    : null;

  try {
    await createApplication({
      teamId,
      athleteFirstName: formData.get("athleteFirstName")?.toString() ?? "",
      athleteLastName: formData.get("athleteLastName")?.toString() ?? "",
      athleteGradYear,
      athletePositions: optional(formData.get("athletePositions")),
      parentFirstName: formData.get("parentFirstName")?.toString() ?? "",
      parentLastName: formData.get("parentLastName")?.toString() ?? "",
      parentEmail,
      parentPhone: optional(formData.get("parentPhone")),
      message: optional(formData.get("message")),
    });
  } catch (err) {
    // createApplication's redirect never runs here, but the redirects in THIS
    // function throw NEXT_REDIRECT — let framework errors propagate untouched.
    unstable_rethrow(err);

    // A validation throw carries a { code } we map straight to the banner.
    const code = (err as { code?: CreateApplicationError })?.code;
    if (code === "missing" || code === "email") {
      redirect(`/travel/apply?error=${code}${teamQuery}`);
    }

    // Anything else is a real failure (DB, etc.) — log + degrade to `missing`
    // rather than showing a raw crash.
    Sentry.captureException(err, {
      tags: { area: "travel-application-submit" },
      extra: { parentEmail, teamId },
    });
    redirect(`/travel/apply?error=missing${teamQuery}`);
  }

  redirect("/travel/apply?submitted=1");
}
