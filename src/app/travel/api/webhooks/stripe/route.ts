// Travel (Block 4b-1) — inbound STRIPE webhook for the travel billing rail.
// Ported from Northstar's /api/webhooks/stripe route. SINGLE Stripe account (no
// Connect). Handles the deposit capture (payment_intent.succeeded) and marks the
// refund/other subscribed events. Nothing here trusts the body until the Stripe
// signature is verified over the exact raw bytes.
//
// WIRING (one-time, in the Stripe dashboard — use TEST mode until go-live):
//   Stripe → Developers → Webhooks → Add endpoint
//     URL:    https://travel.pfaengine.com/travel/api/webhooks/stripe
//     events: payment_intent.succeeded, charge.refunded (add more as needed)
//   Copy the endpoint's signing secret ("whsec_...") into STRIPE_WEBHOOK_SECRET.
//   Until that secret is set this route is DORMANT (acks 200, touches nothing).
//
// RELIABILITY CONTRACT:
//   1. Verify sig (401 if bad).
//   2. Parse event id/type; unparsable/no-id → 200 ack (a retry won't fix it).
//   3. DEDUP: SELECT travelStripeEvents by id → already present → 200 no-op.
//   4. HANDLED type (payment_intent.succeeded) → idempotent applier which records
//      the event row in the SAME atomic db.batch as the balance write.
//   5. RECORD-AFTER-SUCCESS: if the applier THROWS → 500, do NOT record → Stripe
//      RETRIES the money event. Sentry-capture on the failure path.
//   6. UNHANDLED-but-subscribed (charge.refunded, setup_intent.succeeded, ...) →
//      insert the event marker + 200 no-op. (setup_intent.succeeded is 4b-2.)

import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { travelStripeEvents } from "@/db/schema";
import { verifyStripeWebhook } from "@/travel/stripe";
import {
  applyGatewayPaymentFromIntent,
  vaultPaymentMethodFromSetupIntent,
  type PaymentIntentObject,
  type SetupIntentObject,
} from "@/travel/payments";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  // Read the RAW body first — the signature is over these exact bytes, so we
  // must NOT req.json() before verifying.
  const rawBody = await req.text();

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  // DORMANT-SAFE: with no secret configured there is no real Stripe traffic
  // pointed here. Ack 200 (no-op) so an accidental/probe hit never errors.
  if (!secret || secret.trim().length === 0) {
    console.warn(
      "[travel-stripe-webhook] STRIPE_WEBHOOK_SECRET unset — webhook dormant, ignoring event",
    );
    return NextResponse.json({ ok: true, dormant: true });
  }

  // Verify the Stripe signature. Failure → 401, do NOT process.
  const ok = verifyStripeWebhook({
    secret,
    signatureHeader: req.headers.get("stripe-signature") ?? "",
    rawBody,
  });
  if (!ok) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  // From here the request is AUTHENTIC. Parse id/type — an unparsable or
  // id-less verified payload can't be processed and a retry won't help → 200.
  let event: { id?: unknown; type?: unknown; data?: { object?: unknown } };
  try {
    event = JSON.parse(rawBody);
  } catch {
    console.warn("[travel-stripe-webhook] verified body was not JSON; ignoring");
    return NextResponse.json({ ok: true, ignored: "unparsable" });
  }
  const eventId = typeof event.id === "string" ? event.id : null;
  const eventType = typeof event.type === "string" ? event.type : null;
  if (!eventId || !eventType) {
    console.warn(
      "[travel-stripe-webhook] verified event missing id/type; ignoring",
    );
    return NextResponse.json({ ok: true, ignored: "no_id_or_type" });
  }

  // (3) DEDUP: have we already processed this event id? If so, 200 no-op — this
  // is a retried delivery. (For a HANDLED event, the event row is written in the
  // SAME batch as the side effect, so a recorded id always means "fully done".)
  try {
    const [seen] = await db
      .select({ id: travelStripeEvents.id })
      .from(travelStripeEvents)
      .where(eq(travelStripeEvents.id, eventId))
      .limit(1);
    if (seen) {
      return NextResponse.json({ ok: true, duplicate: true });
    }
  } catch (err) {
    // A read failure here is transient (DB blip) — return 500 so Stripe retries
    // rather than risk double-processing on a dropped dedup check.
    Sentry.captureException(err, {
      tags: { webhook: "travel-stripe", step: "dedup" },
    });
    return NextResponse.json(
      { ok: false, error: "dedup_failed" },
      { status: 500 },
    );
  }

  // (4) HANDLED type — run the idempotent applier, which records the event in
  // the SAME atomic batch as its side effect.
  if (eventType === "payment_intent.succeeded") {
    try {
      const paymentIntent = (event.data?.object ?? {}) as PaymentIntentObject;
      await applyGatewayPaymentFromIntent({ eventId, eventType, paymentIntent });
      return NextResponse.json({ ok: true });
    } catch (err) {
      // (5) RECORD-AFTER-SUCCESS: the applier failed → do NOT record the event;
      // return 500 so Stripe RETRIES this money event.
      Sentry.captureException(err, {
        tags: { webhook: "travel-stripe", eventType },
      });
      return NextResponse.json(
        { ok: false, error: "handler_failed" },
        { status: 500 },
      );
    }
  }

  // (4b) HANDLED type — the card-on-file vault. Runs the idempotent applier,
  // which records the event in the SAME atomic batch as its side effect.
  if (eventType === "setup_intent.succeeded") {
    try {
      const setupIntent = (event.data?.object ?? {}) as SetupIntentObject;
      await vaultPaymentMethodFromSetupIntent({
        eventId,
        eventType,
        setupIntent,
      });
      return NextResponse.json({ ok: true });
    } catch (err) {
      // (5) RECORD-AFTER-SUCCESS: the applier failed → do NOT record the event;
      // return 500 so Stripe RETRIES this event.
      Sentry.captureException(err, {
        tags: { webhook: "travel-stripe", eventType },
      });
      return NextResponse.json(
        { ok: false, error: "handler_failed" },
        { status: 500 },
      );
    }
  }

  // (6) UNHANDLED-but-subscribed types (charge.refunded — the refund row is
  // already written by refundPayment) and any unknown type — record the event id
  // + 200 no-op. A failure to record is transient → 500 so Stripe retries.
  try {
    await db
      .insert(travelStripeEvents)
      .values({ id: eventId, type: eventType })
      .onConflictDoNothing();
    return NextResponse.json({ ok: true, noted: "unhandled" });
  } catch (err) {
    Sentry.captureException(err, {
      tags: { webhook: "travel-stripe", step: "record_unhandled", eventType },
    });
    return NextResponse.json(
      { ok: false, error: "record_failed" },
      { status: 500 },
    );
  }
}
