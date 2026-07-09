// Travel (Block 4b-1) — server payment logic for the Stripe billing rail. Ported
// from Northstar's deposit-checkout.ts + refunds.ts + the webhook applier, adapted
// to the Block-4a travel schema and SINGLE Stripe account (NO Connect). Card-on-
// file / off-session / installment allocation / fees / parties-ledger are NOT
// here (they land in later blocks).
//
// MONEY SAFETY:
//   - The invoice balance is decremented EXACTLY ONCE per PaymentIntent: the
//     webhook applier refuses to re-apply a PI whose payment row already exists
//     (keyed on the UNIQUE travelPayments.stripePaymentIntentId), AND the payment
//     INSERT is .onConflictDoNothing() on that same id, AND the travelStripeEvents
//     dedup marker is written in the SAME db.batch as the side effect. Belt AND
//     suspenders against Stripe's at-least-once delivery.
//   - The applied amount is CLAMPED to the live balance, so the balance can never
//     go negative even if Stripe captured more than is owed.
//   - All multi-row writes go through db.batch([...]) — neon-http has no
//     interactive transactions (db.transaction() throws). Ids are pre-generated
//     with crypto.randomUUID().
//
// SECURITY — the IDOR boundary: startDepositCheckout scopes the invoice read to
// the caller-guardian's OWN invoices (travelInvoices.guardianId === guardianId);
// a non-owned/missing invoice id is indistinguishable from a non-existent one
// (→ not_found, no existence leak). The webhook applier is system-trusted
// (Stripe-signature-verified) and operates only on the invoice named in the PI
// metadata.

import { and, eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { db } from "@/db";
import {
  travelGuardians,
  travelInvoices,
  travelPayments,
  travelProducts,
  travelRefunds,
  travelStripeEvents,
} from "@/db/schema";
import {
  createPaymentCheckoutSession,
  createRefund,
  createStripeCustomer,
  stripeConfig,
  StripeError,
} from "@/travel/stripe";

// Invoice statuses that take no new online payment / can't be refunded onto.
const FINAL_STATUSES = new Set(["paid", "void", "refunded"]);

// ---------------------------------------------------------------------------
// Pure money helpers (integer cents; loud throws on caller bugs before a write).
// ---------------------------------------------------------------------------

/** post-payment invoice status from the new balance. */
function nextInvoiceStatus(
  balanceAfterCents: number,
  totalCents: number,
): "pending" | "partial" | "paid" {
  if (balanceAfterCents < 0) {
    throw new Error(
      `nextInvoiceStatus: balanceAfterCents ${balanceAfterCents} < 0`,
    );
  }
  if (balanceAfterCents === 0) return "paid";
  if (balanceAfterCents >= totalCents) return "pending";
  return "partial";
}

/** The most that can still be refunded: captured − already-refunded (≥ 0). */
function maxRefundableCents(
  capturedCents: number,
  alreadyRefundedCents: number,
): number {
  if (alreadyRefundedCents > capturedCents) {
    throw new Error(
      `maxRefundableCents: alreadyRefunded ${alreadyRefundedCents} > captured ${capturedCents}`,
    );
  }
  return capturedCents - alreadyRefundedCents;
}

// ---------------------------------------------------------------------------
// ensureStripeCustomerForTravelGuardian — resolve (or create + persist) the
// guardian's Stripe Customer id on the SINGLE platform account.
// ---------------------------------------------------------------------------

export type EnsureCustomerResult =
  | { ok: true; customerId: string }
  | { ok: false; error: "no_guardian" | "not_configured" };

/**
 * Return the guardian's Stripe Customer id, creating + persisting one if absent.
 * If travelGuardians.stripeCustomerId is already set, it's returned as-is. Else
 * a Customer is created (email/name/metadata `{ guardianId }`), persisted onto
 * the guardian row, and returned. NO connected account.
 */
export async function ensureStripeCustomerForTravelGuardian(
  guardianId: string,
): Promise<EnsureCustomerResult> {
  if (stripeConfig() === null) return { ok: false, error: "not_configured" };

  const [guardian] = await db
    .select({
      id: travelGuardians.id,
      email: travelGuardians.email,
      firstName: travelGuardians.firstName,
      lastName: travelGuardians.lastName,
      stripeCustomerId: travelGuardians.stripeCustomerId,
    })
    .from(travelGuardians)
    .where(eq(travelGuardians.id, guardianId))
    .limit(1);

  if (!guardian) return { ok: false, error: "no_guardian" };
  if (guardian.stripeCustomerId) {
    return { ok: true, customerId: guardian.stripeCustomerId };
  }

  const name = `${guardian.firstName} ${guardian.lastName}`.trim();
  const created = await createStripeCustomer({
    email: guardian.email,
    name: name.length > 0 ? name : null,
    metadata: { guardianId: guardian.id },
  });

  await db
    .update(travelGuardians)
    .set({ stripeCustomerId: created.id })
    .where(eq(travelGuardians.id, guardian.id));

  return { ok: true, customerId: created.id };
}

// ---------------------------------------------------------------------------
// startDepositCheckout — create the hosted Checkout Session for ONE of the
// caller-guardian's own invoices and return its URL. CAPTURES NOTHING here; the
// money moves on Stripe's hosted page and lands via the webhook.
// ---------------------------------------------------------------------------

export type StartDepositCheckoutResult =
  | { ok: true; url: string }
  | {
      ok: false;
      error:
        | "not_configured"
        | "not_found"
        | "not_payable"
        | "no_guardian"
        | "stripe_error";
    };

/**
 * Begin the deposit-prime flow for ONE of the caller-guardian's own invoices:
 *   1. DORMANT-SAFE: bail if Stripe is unconfigured.
 *   2. IDOR: load the invoice scoped to travelInvoices.guardianId === guardianId;
 *      a non-owned/missing id → not_found (no existence leak).
 *   3. Reject already-final invoices and zero/negative balances → not_payable.
 *   4. deposit = the product's depositCents (via the invoice's productId) when
 *      set, else the full balance; then CLAMP to min(deposit, balanceCents).
 *   5. Ensure the guardian's Stripe Customer, then create a mode=payment Checkout
 *      Session (metadata { invoiceId, guardianId, kind:"deposit" }) and return
 *      its hosted url. The invoice balance is NOT touched here.
 */
export async function startDepositCheckout(params: {
  guardianId: string;
  invoiceId: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<StartDepositCheckoutResult> {
  if (stripeConfig() === null) return { ok: false, error: "not_configured" };

  // (2) IDOR-scoped invoice read (own guardian only). Join the product for its
  // deposit + a label.
  const [invoice] = await db
    .select({
      id: travelInvoices.id,
      guardianId: travelInvoices.guardianId,
      balanceCents: travelInvoices.balanceCents,
      status: travelInvoices.status,
      productName: travelProducts.name,
      depositCents: travelProducts.depositCents,
    })
    .from(travelInvoices)
    .leftJoin(travelProducts, eq(travelProducts.id, travelInvoices.productId))
    .where(
      and(
        eq(travelInvoices.id, params.invoiceId),
        eq(travelInvoices.guardianId, params.guardianId),
      ),
    )
    .limit(1);

  if (!invoice) return { ok: false, error: "not_found" };

  // (3) Reject final-status invoices and nothing-to-pay balances.
  if (FINAL_STATUSES.has(invoice.status) || invoice.balanceCents <= 0) {
    return { ok: false, error: "not_payable" };
  }

  // (4) Deposit = product deposit when set, else full balance; clamp to balance
  // so we never charge more than is owed.
  const target =
    invoice.depositCents != null && invoice.depositCents > 0
      ? invoice.depositCents
      : invoice.balanceCents;
  const depositCents = Math.min(target, invoice.balanceCents);

  // (5) Ensure the Stripe Customer, then create the hosted Checkout session. The
  // PI carries our metadata so the webhook can map the capture back.
  const ensured = await ensureStripeCustomerForTravelGuardian(params.guardianId);
  if (!ensured.ok) {
    return {
      ok: false,
      error: ensured.error === "no_guardian" ? "no_guardian" : "not_configured",
    };
  }

  const label = `Deposit — ${invoice.productName ?? "PFA Travel deposit"}`;
  try {
    const session = await createPaymentCheckoutSession({
      customerId: ensured.customerId,
      amountCents: depositCents,
      productName: label,
      successUrl: params.successUrl,
      cancelUrl: params.cancelUrl,
      metadata: {
        invoiceId: invoice.id,
        guardianId: params.guardianId,
        kind: "deposit",
      },
    });
    return { ok: true, url: session.url };
  } catch (err) {
    if (err instanceof StripeError) return { ok: false, error: "stripe_error" };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// applyGatewayPaymentFromIntent — the webhook's payment recorder. THE MONEY-
// SAFETY POINT: the ONLY place a gateway capture decrements a travel invoice
// balance, and it runs only from the signature-verified webhook.
// ---------------------------------------------------------------------------

/**
 * A minimal shape of the Stripe payment_intent object as it arrives on a
 * payment_intent.succeeded event (only the fields we read). `latest_charge` may
 * be a bare id string OR an expanded object — we only trust the string form.
 */
export type PaymentIntentObject = {
  id?: unknown;
  amount?: unknown;
  amount_received?: unknown;
  latest_charge?: unknown;
  metadata?: Record<string, unknown> | null;
};

export class TravelWebhookError extends Error {}

/**
 * Apply a gateway capture for a VERIFIED payment_intent.succeeded event.
 *
 * Idempotent under at-least-once delivery:
 *   - fast-path no-op if a travelStripeEvents row for this event id already
 *     exists (a re-delivery we've already handled), OR a travelPayments row for
 *     this PI id already exists (this PI was already applied under some event),
 *   - the payment INSERT is .onConflictDoNothing() on the UNIQUE
 *     stripePaymentIntentId, AND
 *   - the travelStripeEvents dedup marker is written in the SAME db.batch as the
 *     side effect, so the event is marked processed ONLY as part of a SUCCESSFUL
 *     apply.
 *
 * THROWS (TravelWebhookError) on a failure to resolve the invoice or the captured
 * amount, so the webhook route returns 500 and Stripe RETRIES the money event.
 * On every NON-throw no-op path this records the travelStripeEvents marker so the
 * route just returns 200.
 */
export async function applyGatewayPaymentFromIntent(params: {
  eventId: string;
  eventType: string;
  paymentIntent: PaymentIntentObject;
}): Promise<void> {
  const pi = params.paymentIntent ?? {};
  const piId = typeof pi.id === "string" ? pi.id : null;

  const metadata: Record<string, string> = {};
  for (const [k, v] of Object.entries(pi.metadata ?? {})) {
    if (typeof v === "string") metadata[k] = v;
  }
  const invoiceId = metadata.invoiceId;
  const guardianId = metadata.guardianId ?? null;
  const kind = metadata.kind;

  // amount_received (preferred) or amount; latest charge id (string form only).
  const amountReceivedCents =
    typeof pi.amount_received === "number"
      ? pi.amount_received
      : typeof pi.amount === "number"
        ? pi.amount
        : null;
  const latestChargeId =
    typeof pi.latest_charge === "string" ? pi.latest_charge : null;

  // Record the processed-event marker (idempotent). Used on every no-op path.
  const recordEventOnly = () =>
    db
      .insert(travelStripeEvents)
      .values({ id: params.eventId, type: params.eventType })
      .onConflictDoNothing();

  // (1) EVENT-ID dedup fast-path.
  const [seenEvent] = await db
    .select({ id: travelStripeEvents.id })
    .from(travelStripeEvents)
    .where(eq(travelStripeEvents.id, params.eventId))
    .limit(1);
  if (seenEvent) return;

  // (2) NOT OURS — a succeeded PI we didn't originate (no deposit metadata /
  // invoice / id). Record the event + no-op (we touch no invoice).
  if (kind !== "deposit" || !invoiceId || !piId) {
    await recordEventOnly();
    return;
  }

  // (3) DUPLICATE BY PI — the balance is only ever decremented on the FIRST
  // event that introduces this PI's payment row.
  const [existingPayment] = await db
    .select({ id: travelPayments.id })
    .from(travelPayments)
    .where(eq(travelPayments.stripePaymentIntentId, piId))
    .limit(1);
  if (existingPayment) {
    await recordEventOnly();
    return;
  }

  // (4) Load the invoice. MISSING → throw (route 500 → Stripe retries): a
  // captured deposit with no invoice to apply to must SURFACE, not be dropped.
  const [invoice] = await db
    .select({
      id: travelInvoices.id,
      guardianId: travelInvoices.guardianId,
      totalCents: travelInvoices.totalCents,
      balanceCents: travelInvoices.balanceCents,
      status: travelInvoices.status,
    })
    .from(travelInvoices)
    .where(eq(travelInvoices.id, invoiceId))
    .limit(1);
  if (!invoice) {
    throw new TravelWebhookError(
      `payment_intent.succeeded for invoice ${invoiceId} which does not exist`,
    );
  }

  // (5) Already-final invoice — don't double-apply onto a settled invoice.
  if (FINAL_STATUSES.has(invoice.status)) {
    await recordEventOnly();
    return;
  }

  // (6) Captured amount. Must resolve — else throw so Stripe retries.
  if (amountReceivedCents === null) {
    throw new TravelWebhookError(
      `payment_intent.succeeded ${piId} had no resolvable amount_received`,
    );
  }

  // (7) Clamp the applied amount to the live balance (never-negative) + derive
  // the new status.
  const appliedCents = Math.min(amountReceivedCents, invoice.balanceCents);
  const balanceAfterCents = invoice.balanceCents - appliedCents;
  const status = nextInvoiceStatus(balanceAfterCents, invoice.totalCents);

  const now = new Date();
  const paymentId = crypto.randomUUID();

  // (8) ONE atomic db.batch: payment insert (idempotent on the UNIQUE PI id) +
  // invoice balance/status update + the event dedup marker — all commit together.
  const statements: BatchItem<"pg">[] = [
    db
      .insert(travelPayments)
      .values({
        id: paymentId,
        invoiceId: invoice.id,
        guardianId: guardianId ?? invoice.guardianId,
        paymentMethodId: null,
        amountCents: appliedCents,
        channel: "card",
        status: "succeeded",
        stripeChargeId: latestChargeId,
        stripePaymentIntentId: piId,
        paidAt: now,
      })
      .onConflictDoNothing({ target: travelPayments.stripePaymentIntentId }),
    db
      .update(travelInvoices)
      .set({ balanceCents: balanceAfterCents, status })
      .where(eq(travelInvoices.id, invoice.id)),
    db
      .insert(travelStripeEvents)
      .values({ id: params.eventId, type: params.eventType })
      .onConflictDoNothing(),
  ];

  await db.batch(
    statements as [(typeof statements)[number], ...typeof statements],
  );
}

// ---------------------------------------------------------------------------
// refundPayment — refund (part of) a captured payment through Stripe, record an
// immutable travelRefunds row, restore the invoice balance, and flip statuses.
// NO fee/claw-back/parties logic (that's Block 5). NO Connect account.
// ---------------------------------------------------------------------------

export type RefundResult =
  | {
      ok: true;
      refundId: string;
      refundedTotalCents: number;
      newBalanceCents: number;
      paymentStatus: "succeeded" | "refunded";
    }
  | {
      ok: false;
      error:
        | "not_found"
        | "not_refundable"
        | "amount_invalid"
        | "amount_exceeds"
        | "not_configured"
        | "stripe_error";
    };

/**
 * Refund `amountCents` against payment `paymentId`. Only a succeeded card payment
 * with a stripeChargeId is refunded through Stripe; validates amount ≤ still-
 * refundable (captured − already-refunded), then in ONE db.batch: insert the
 * immutable refund row, restore the invoice balance (+= refund), and flip the
 * payment to 'refunded' when fully returned + the invoice status accordingly.
 */
export async function refundPayment(params: {
  paymentId: string;
  amountCents: number;
  reason?: string | null;
}): Promise<RefundResult> {
  const [payment] = await db
    .select({
      id: travelPayments.id,
      invoiceId: travelPayments.invoiceId,
      amountCents: travelPayments.amountCents,
      status: travelPayments.status,
      stripeChargeId: travelPayments.stripeChargeId,
    })
    .from(travelPayments)
    .where(eq(travelPayments.id, params.paymentId))
    .limit(1);

  if (!payment) return { ok: false, error: "not_found" };
  // Only a successfully-captured payment can be refunded.
  if (payment.status !== "succeeded") {
    return { ok: false, error: "not_refundable" };
  }

  if (!Number.isInteger(params.amountCents) || params.amountCents <= 0) {
    return { ok: false, error: "amount_invalid" };
  }

  // Already-refunded total → how much is still refundable.
  const priorRefunds = await db
    .select({ amountCents: travelRefunds.amountCents })
    .from(travelRefunds)
    .where(eq(travelRefunds.paymentId, payment.id));
  const alreadyRefunded = priorRefunds.reduce((n, r) => n + r.amountCents, 0);
  const refundable = maxRefundableCents(payment.amountCents, alreadyRefunded);
  if (params.amountCents > refundable) {
    return { ok: false, error: "amount_exceeds" };
  }

  // The invoice this payment is against (for the balance restore).
  const [invoice] = payment.invoiceId
    ? await db
        .select({
          id: travelInvoices.id,
          totalCents: travelInvoices.totalCents,
          balanceCents: travelInvoices.balanceCents,
        })
        .from(travelInvoices)
        .where(eq(travelInvoices.id, payment.invoiceId))
        .limit(1)
    : [undefined];

  // Gateway refund (a card payment with a charge id). No charge id → no Stripe
  // call (a manual payment), recorded refund-only.
  let stripeRefundId: string | null = null;
  if (payment.stripeChargeId) {
    if (stripeConfig() === null) return { ok: false, error: "not_configured" };
    try {
      const r = await createRefund(
        { chargeId: payment.stripeChargeId, amountCents: params.amountCents },
        // Keyed on the running refunded total → a retry can't double-refund.
        `refund_${payment.id}_${alreadyRefunded + params.amountCents}`,
      );
      stripeRefundId = r.id;
    } catch (err) {
      if (err instanceof StripeError) return { ok: false, error: "stripe_error" };
      throw err;
    }
  }

  const refundedTotalCents = alreadyRefunded + params.amountCents;
  const paymentStatus: "succeeded" | "refunded" =
    refundedTotalCents >= payment.amountCents ? "refunded" : "succeeded";

  const refundId = crypto.randomUUID();
  const statements: BatchItem<"pg">[] = [
    db.insert(travelRefunds).values({
      id: refundId,
      paymentId: payment.id,
      amountCents: params.amountCents,
      reason: params.reason ?? null,
      stripeRefundId,
    }),
  ];

  let newBalanceCents = invoice?.balanceCents ?? 0;
  if (invoice) {
    newBalanceCents = invoice.balanceCents + params.amountCents;
    const newStatus = nextInvoiceStatus(newBalanceCents, invoice.totalCents);
    statements.push(
      db
        .update(travelInvoices)
        .set({ balanceCents: newBalanceCents, status: newStatus })
        .where(eq(travelInvoices.id, invoice.id)),
    );
  }

  if (paymentStatus === "refunded") {
    statements.push(
      db
        .update(travelPayments)
        .set({ status: "refunded" })
        .where(eq(travelPayments.id, payment.id)),
    );
  }

  await db.batch(
    statements as [(typeof statements)[number], ...typeof statements],
  );

  return {
    ok: true,
    refundId,
    refundedTotalCents,
    newBalanceCents,
    paymentStatus,
  };
}
