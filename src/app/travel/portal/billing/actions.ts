"use server";

import { headers } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";
import * as Sentry from "@sentry/nextjs";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { travelInvoices } from "@/db/schema";
import { checkMagicLinkRateLimit } from "@/lib/ratelimit";
import { requireTravelGuardian } from "@/travel/authz";
import { startDepositCheckout } from "@/travel/payments";
import { createMonthlyPlanForInvoice } from "@/travel/plans";

// Block 4c — the parent checkout server action. A signed-in travel GUARDIAN pays
// the deposit on ONE of their OWN invoices by starting a Stripe Hosted Checkout
// session (Block-4b-1 startDepositCheckout) and being redirected to Stripe's
// hosted page. NO new Stripe/DB logic here — this only wires the existing engine.
//
// Structure mirrors src/app/travel/portal/register/actions.ts: getClientIp
// (copied so no shared file is touched), a rate-limit gate BEFORE the Stripe
// call, ?error=<code> banner redirects on failure, and unstable_rethrow →
// Sentry on an unexpected throw. On success we redirect to the Stripe url.

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

// Stripe Hosted Checkout requires ABSOLUTE success/cancel URLs. Derive the
// request origin from the incoming headers: prefer the `origin` header, else
// reconstruct it from x-forwarded-proto + host (Vercel sets both).
async function getRequestOrigin(): Promise<string> {
  const h = await headers();
  const origin = h.get("origin");
  if (origin) return origin.replace(/\/+$/, "");
  const proto = h.get("x-forwarded-proto") ?? "https";
  const host = h.get("host") ?? "";
  return `${proto}://${host}`.replace(/\/+$/, "");
}

export async function payDeposit(formData: FormData): Promise<void> {
  // Guardian-only: a non-guardian (admin / no session) is bounced to sign-in,
  // exactly as the portal page is. requireTravelGuardian redirects internally.
  const guardian = await requireTravelGuardian();

  // Rate-limit on (guardianId, IP) BEFORE the Stripe call — same shared cap the
  // magic-link surfaces use. Keyed on the guardian id (a stable session subject).
  const ip = await getClientIp();
  const decision = await checkMagicLinkRateLimit(guardian.id, ip);
  if (!decision.allowed) {
    redirect("/travel/portal/billing?error=rate");
  }

  const invoiceId = formData.get("invoiceId")?.toString().trim();
  if (!invoiceId) {
    redirect("/travel/portal/billing?error=not_found");
  }

  const origin = await getRequestOrigin();
  const successUrl = `${origin}/travel/portal/billing?paid=1&invoice=${invoiceId}`;
  const cancelUrl = `${origin}/travel/portal/billing?canceled=1`;

  let result: Awaited<ReturnType<typeof startDepositCheckout>>;
  try {
    result = await startDepositCheckout({
      guardianId: guardian.id,
      invoiceId,
      successUrl,
      cancelUrl,
    });
  } catch (err) {
    // The redirects in THIS function throw NEXT_REDIRECT — let framework errors
    // propagate untouched before treating anything as a real failure.
    unstable_rethrow(err);

    Sentry.captureException(err, {
      tags: { area: "travel-billing-pay-deposit" },
      extra: { guardianId: guardian.id, invoiceId },
    });
    redirect("/travel/portal/billing?error=stripe_error");
  }

  if (!result.ok) {
    // Map the engine's typed error straight onto a friendly banner code. Every
    // StartDepositCheckoutResult error string is a valid ?error= code the page
    // renders.
    redirect(`/travel/portal/billing?error=${result.error}`);
  }

  // Success: send the parent to Stripe's hosted checkout page.
  redirect(result.url);
}

// ---------------------------------------------------------------------------
// enrollInMonthlyPlan (Block 4b-2-b-2) — a signed-in travel GUARDIAN enrolls ONE
// of their OWN invoices into the fixed-monthly autopay plan. This only MINTS the
// plan (installments + due scheduled_charges); the cron charges later. NO new
// styled UI here — Block 4b-2-c adds the button + card list + banners. This wires
// the existing createMonthlyPlanForInvoice engine, mirroring payDeposit's shape.
//
// IDOR: the invoice ownership is verified HERE (travelInvoices.guardianId ===
// guardian.id) BEFORE calling the engine — we do not rely on the engine alone,
// which is system-trusted and takes a bare invoiceId.
// ---------------------------------------------------------------------------

export async function enrollInMonthlyPlan(formData: FormData): Promise<void> {
  // Guardian-only (redirects internally for a non-guardian / no session).
  const guardian = await requireTravelGuardian();

  // Rate-limit on (guardianId, IP) BEFORE any DB/engine work — same shared cap.
  const ip = await getClientIp();
  const decision = await checkMagicLinkRateLimit(guardian.id, ip);
  if (!decision.allowed) {
    redirect("/travel/portal/billing?error=rate");
  }

  const invoiceId = formData.get("invoiceId")?.toString().trim();
  if (!invoiceId) {
    redirect("/travel/portal/billing?error=not_found");
  }

  try {
    // IDOR gate: the invoice MUST belong to the caller-guardian. A non-owned /
    // missing id is indistinguishable → not_found (no existence leak).
    const [owned] = await db
      .select({ id: travelInvoices.id })
      .from(travelInvoices)
      .where(
        and(
          eq(travelInvoices.id, invoiceId),
          eq(travelInvoices.guardianId, guardian.id),
        ),
      )
      .limit(1);
    if (!owned) {
      redirect("/travel/portal/billing?error=not_found");
    }

    const result = await createMonthlyPlanForInvoice({ invoiceId });
    if (!result.ok) {
      // Each engine error code is a valid ?error= banner code (rendered by 4b-2-c).
      redirect(`/travel/portal/billing?error=${result.error}`);
    }
  } catch (err) {
    // The redirects above throw NEXT_REDIRECT — let framework errors propagate.
    unstable_rethrow(err);
    Sentry.captureException(err, {
      tags: { area: "travel-billing-enroll-monthly" },
      extra: { guardianId: guardian.id, invoiceId },
    });
    redirect("/travel/portal/billing?error=1");
  }

  redirect("/travel/portal/billing?planned=1");
}
