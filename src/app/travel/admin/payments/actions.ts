"use server";

import { headers } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";
import * as Sentry from "@sentry/nextjs";
import { checkMagicLinkRateLimit } from "@/lib/ratelimit";
import { requireTravelAccess } from "@/travel/authz";
import { refundPayment } from "@/travel/payments";

// Block 4d — the operator REFUND server action. requireTravelAccess() FIRST (its
// own entry point — a server action is not protected by the page guard), so a
// guardian / no-session caller is bounced to sign-in BEFORE any refund work. It
// only WIRES the already-built + tested refundPayment engine (Stripe refund +
// immutable travelRefunds row + invoice-balance restore + status flip, all
// atomic); no new Stripe/refund logic lives here.
//
// Money boundary: the operator types a DOLLAR string; this action converts it to
// integer CENTS server-side (the same dollarsToCents helper the product actions
// use) before calling in. Each RefundResult error code maps straight onto a
// ?error=<code> banner the payments page renders.

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

// Parse a DOLLAR string ("500", "500.00", "$1,500.00") → non-negative integer
// CENTS, or null if it isn't a valid non-negative money amount. Same conversion
// as the product actions (the money-correctness boundary — client never sends
// cents). Strips $ and thousands separators; rejects non-numeric / negative;
// rounds to the nearest cent.
function dollarsToCents(raw: string | null): number | null {
  if (raw === null) return null;
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (cleaned === "") return null;
  const dollars = Number(cleaned);
  if (!Number.isFinite(dollars) || dollars < 0) return null;
  return Math.round(dollars * 100);
}

export async function issueRefund(formData: FormData): Promise<void> {
  // Operator-only (admin OR travel_admin). A guardian / no session is bounced to
  // sign-in — refunds are NEVER exposed to a guardian. Redirects internally.
  const session = await requireTravelAccess();

  // Rate-limit on (operatorId, IP) BEFORE the Stripe call — same shared cap the
  // other travel action surfaces use. Keyed on the operator's stable user id.
  const ip = await getClientIp();
  const decision = await checkMagicLinkRateLimit(
    session.user.id ?? session.user.email ?? "operator",
    ip,
  );
  if (!decision.allowed) {
    redirect("/travel/admin/payments?error=rate");
  }

  const paymentId = formData.get("paymentId")?.toString().trim();
  if (!paymentId) {
    redirect("/travel/admin/payments?error=not_found");
  }

  // Blank / non-numeric / negative dollar entry → amount_invalid (the engine
  // rejects a 0/negative amount too, so it stays the single source of truth).
  const amountCents = dollarsToCents(
    formData.get("amountDollars")?.toString() ?? null,
  );
  if (amountCents === null) {
    redirect("/travel/admin/payments?error=amount_invalid");
  }

  const reasonRaw = formData.get("reason")?.toString().trim();
  const reason = reasonRaw ? reasonRaw : null;

  let result: Awaited<ReturnType<typeof refundPayment>>;
  try {
    result = await refundPayment({ paymentId, amountCents, reason });
  } catch (err) {
    // The redirects above throw NEXT_REDIRECT — let framework errors propagate
    // before treating anything as a real failure.
    unstable_rethrow(err);
    Sentry.captureException(err, {
      tags: { area: "travel-payment-refund" },
      extra: { paymentId },
    });
    redirect("/travel/admin/payments?error=1");
  }

  if (!result.ok) {
    // Each RefundResult error string is a valid ?error= code the page renders.
    redirect(`/travel/admin/payments?error=${result.error}`);
  }

  redirect("/travel/admin/payments?refunded=1");
}
