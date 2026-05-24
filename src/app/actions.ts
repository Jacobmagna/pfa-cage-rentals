"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { signIn } from "@/auth";
import { checkMagicLinkRateLimit } from "@/lib/ratelimit";

// Magic-link request flow with rate limiting. Pulled out of the
// inline action in page.tsx so the rate-limit check + IP extraction
// have a real home and the page component stays focused on rendering.
//
// Error surface: redirect back to `/` with `?error=<code>`. The
// page reads searchParams.error and shows a banner. A `useActionState`
// client component would be cleaner once the sign-in surface grows,
// but for a single form the query-param dance is simpler and works
// across all browsers without extra JS.

async function getClientIp(): Promise<string> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0]!.trim();
  }
  return h.get("x-real-ip") ?? "unknown";
}

export async function requestMagicLink(formData: FormData): Promise<void> {
  const email = formData.get("email")?.toString().trim();
  if (!email) redirect("/?error=missing-email");

  const ip = await getClientIp();
  const decision = await checkMagicLinkRateLimit(email, ip);
  if (!decision.allowed) {
    redirect(`/?error=${decision.reason}`);
  }

  await signIn("resend", { email, redirectTo: "/" });
}
