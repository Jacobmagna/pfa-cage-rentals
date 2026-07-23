"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import { eq } from "drizzle-orm";
import { z } from "zod";
import * as Sentry from "@sentry/nextjs";
import { signIn } from "@/auth";
import { db } from "@/db";
import { users } from "@/db/schema";
import { logAudit } from "@/lib/audit";
import { requireSession } from "@/lib/authz";
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
  // Prefer the platform-trusted client IP. On Vercel, `x-vercel-forwarded-for`
  // is set by the platform to the real client IP and CANNOT be forged by the
  // client, so the per-IP magic-link rate limit can't be evaded by spoofing
  // `x-forwarded-for`. Fall back to `x-real-ip`, then the (spoofable)
  // `x-forwarded-for` first entry only as a last resort.
  const vercel = h.get("x-vercel-forwarded-for");
  if (vercel) {
    return vercel.split(",")[0]!.trim();
  }
  const real = h.get("x-real-ip");
  if (real) {
    return real.trim();
  }
  const forwarded = h.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0]!.trim();
  }
  return "unknown";
}

export async function requestMagicLink(formData: FormData): Promise<void> {
  const email = formData.get("email")?.toString().trim();
  if (!email) redirect("/?error=missing-email");

  const ip = await getClientIp();
  const decision = await checkMagicLinkRateLimit(email, ip);
  if (!decision.allowed) {
    redirect(`/?error=${decision.reason}`);
  }

  // On SUCCESS, signIn throws NEXT_REDIRECT to send the user to `redirectTo`
  // — that control-flow throw MUST propagate untouched or sign-in breaks for
  // everyone. So the catch calls unstable_rethrow FIRST (same guard page.tsx
  // uses) to re-throw framework errors; only a REAL send failure (e.g. the
  // Resend free-tier 100/day cap → 429, or a transient network error) gets
  // past it. We capture it to Sentry so the masked prod error is diagnosable
  // next time, then degrade to the graceful `?error=send-failed` banner.
  try {
    await signIn("resend", { email, redirectTo: "/" });
  } catch (err) {
    unstable_rethrow(err);
    Sentry.captureException(err, {
      tags: { area: "magic-link-send" },
      extra: { email },
    });
    // captureException only QUEUES the event; Sentry's transport ships it
    // asynchronously. redirect() throws immediately, ending the request, and
    // a serverless function can be frozen the instant its work completes —
    // so the event was being dropped before it left the box. That is why this
    // instrumentation logged ZERO `area:magic-link-send` events in 14 days
    // even though a real coach (Ryan Merriwether, 2026-07-18) definitively
    // hit this path. Flush first so the report actually goes out.
    //
    // Bounded at 2s and .catch()-guarded: this is the LOGIN path, so a slow
    // or failing Sentry transport must never escalate a handled send failure
    // back into the raw 500 we fixed on 2026-07-02. flush() resolves as soon
    // as the queue drains (typically ms) — 2000 is a ceiling, not a delay,
    // and it is only ever paid on an already-failing request.
    await Sentry.flush(2000).catch(() => {});
    redirect("/?error=send-failed");
  }
}

// Lets a signed-in user edit their own display name. Solves two problems:
// (1) Google sign-in pulls the OAuth account's display name, which often
//     doesn't match how the coach is known (Gmail nickname, alias account);
// (2) overlap-conflict errors show coachName ?? coachEmail — populating
//     name reliably keeps the email fallback from firing in user-facing copy.
//
// Coach and admin both call the same action via [[updateOwnNameSchema]].
// Trim + non-empty + reasonable max-length; longer trips Zod and surfaces
// as a thrown ZodError caught by the caller's UI.
const updateOwnNameSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name cannot be empty")
    .max(80, "Name must be 80 characters or fewer"),
});

export async function updateOwnName(input: unknown): Promise<{ name: string }> {
  const session = await requireSession();
  const { name } = updateOwnNameSchema.parse(input);

  const [before] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1);

  await db.update(users).set({ name }).where(eq(users.id, session.user.id));

  await logAudit(db, {
    actorUserId: session.user.id,
    entityType: "user",
    entityId: session.user.id,
    action: "update",
    before: { name: before?.name ?? null },
    after: { name },
  });

  // Re-render every surface that shows the current user's name.
  revalidatePath("/admin");
  revalidatePath("/coach");
  revalidatePath("/admin/coaches");
  return { name };
}
