// Travel (Block 4b-2-b-3) — the autopay EXECUTOR. A background job that finds DUE
// scheduled charges and charges the family's saved card OFF-SESSION on the SINGLE
// Stripe platform account (NO Connect). Ported-in spirit from Northstar's
// scheduled-charge runner, adapted to the Block-4a/4b travel schema.
//
// MONEY SAFETY — the two invariants that make this never double-capture:
//   1. CLAIM-FIRST LOCK. Before touching Stripe, each candidate row is claimed
//      with a STANDALONE conditional UPDATE ... WHERE claimed_at IS NULL AND
//      status='scheduled' ... RETURNING id. Only the runner that WINS that row
//      (gets a returned id) may charge it — a concurrent runner that loses the
//      race sees 0 rows and skips. This is the concurrency gate.
//   2. PER-CHARGE IDEMPOTENCY-KEY. The off-session PaymentIntent is created with
//      `schedcharge_${charge.id}` as its Idempotency-Key, so even a retry (or a
//      lock that somehow ran twice) can NEVER create a second capture at Stripe.
//
// DIVISION OF WRITES — the runner INITIATES, the webhook SETTLES:
//   The runner ONLY writes: the claim (claimed_at), the stripe_ref on success,
//   and the failure bookkeeping on a Stripe decline. It does NOT set status
//   'charged', does NOT reduce the invoice balance, and does NOT mark the
//   installment paid. Those money writes happen EXACTLY ONCE, later, in the
//   signature-verified payment_intent.succeeded webhook (applyGatewayPaymentFromIntent),
//   which is idempotent on the UNIQUE PaymentIntent id. Keeping the balance write
//   in one place — the webhook — is what prevents a double-write: if the runner
//   also reduced the balance, a webhook redelivery (or a runner/webhook race)
//   could apply the same capture twice. The runner sets stripe_ref so the charge
//   is traceable; the webhook flips status→'charged' when Stripe confirms.
//
// DORMANT-SAFE: with Stripe unconfigured (stripeConfig() === null) the runner
// does nothing and reports { status: "disabled" }.
//
// neon-http: NO db.transaction / NO db.batch here. Each per-charge write is a
// STANDALONE db.update(...) (a .returning() is allowed on a standalone update —
// the no-.returning() limit only applies INSIDE db.batch).

import { and, asc, desc, eq, isNull, lte } from "drizzle-orm";

import { db } from "@/db";
import {
  travelGuardians,
  travelInvoices,
  travelPaymentMethods,
  travelScheduledCharges,
} from "@/db/schema";
import {
  createOffSessionPaymentIntent,
  stripeConfig,
  StripeError,
} from "@/travel/stripe";

// Invoice statuses that are FINAL — a scheduled charge against one of these is
// moot (nothing left to collect). Mirrors payments.ts FINAL_STATUSES.
const FINAL_INVOICE_STATUSES = new Set(["paid", "void", "refunded"]);

/** The per-run outcome tally. */
export type RunScheduledChargesSummary = {
  status: "ok" | "disabled";
  /** candidate rows that were DUE at claim-select time. */
  due: number;
  /** rows THIS run successfully claim-first locked. */
  claimed: number;
  /** claimed rows whose off-session charge was INITIATED at Stripe (stripe_ref set). */
  initiated: number;
  /** claimed rows voided because their invoice was already settled/gone. */
  cancelled: number;
  /** claimed rows that failed (no card / Stripe decline). */
  failed: number;
};

/** The disabled (Stripe-unconfigured) summary — a single source of truth. */
function disabledSummary(): RunScheduledChargesSummary {
  return {
    status: "disabled",
    due: 0,
    claimed: 0,
    initiated: 0,
    cancelled: 0,
    failed: 0,
  };
}

/**
 * Clamp the charge amount to what is still owed — NEVER charge more than the
 * live invoice balance. Pure; exported for a focused unit test.
 */
export function clampChargeAmountCents(
  chargeAmountCents: number,
  invoiceBalanceCents: number,
): number {
  return Math.min(chargeAmountCents, invoiceBalanceCents);
}

/**
 * Find DUE scheduled charges and charge each family's saved default card
 * off-session. See the module header for the money-safety contract.
 *
 * @param opts.now         Override "now" (for deterministic runs/tests). Default new Date().
 * @param opts.maxPerRun   Cap candidates per run. Default 200.
 */
export async function runScheduledCharges(opts?: {
  now?: Date;
  maxPerRun?: number;
}): Promise<RunScheduledChargesSummary> {
  // DORMANT-SAFE: Stripe unconfigured → do nothing.
  if (stripeConfig() === null) return disabledSummary();

  const now = opts?.now ?? new Date();
  const maxPerRun = opts?.maxPerRun ?? 200;

  // Candidate DUE charges: scheduled, unclaimed, run_on in the past. Oldest first.
  const candidates = await db
    .select({
      id: travelScheduledCharges.id,
      invoiceId: travelScheduledCharges.invoiceId,
      amountCents: travelScheduledCharges.amountCents,
      installmentId: travelScheduledCharges.installmentId,
      attemptCount: travelScheduledCharges.attemptCount,
    })
    .from(travelScheduledCharges)
    .where(
      and(
        eq(travelScheduledCharges.status, "scheduled"),
        isNull(travelScheduledCharges.claimedAt),
        lte(travelScheduledCharges.runOn, now),
      ),
    )
    .orderBy(asc(travelScheduledCharges.runOn))
    .limit(maxPerRun);

  const summary: RunScheduledChargesSummary = {
    status: "ok",
    due: candidates.length,
    claimed: 0,
    initiated: 0,
    cancelled: 0,
    failed: 0,
  };

  for (const charge of candidates) {
    // Each charge is processed independently — one failure must not abort the
    // batch. A NON-StripeError (unexpected) is rethrown out of the loop below,
    // where it aborts the run (a genuine bug/infra failure should surface).
    // (1) CLAIM-FIRST — the concurrency gate. Standalone conditional UPDATE.
    const claimed = await db
      .update(travelScheduledCharges)
      .set({ claimedAt: now })
      .where(
        and(
          eq(travelScheduledCharges.id, charge.id),
          isNull(travelScheduledCharges.claimedAt),
          eq(travelScheduledCharges.status, "scheduled"),
        ),
      )
      .returning({ id: travelScheduledCharges.id });

    if (claimed.length === 0) {
      // Another runner won this row (or it changed under us) — skip, don't count.
      continue;
    }
    summary.claimed += 1;

    // (2) Re-read the invoice — the charge is moot if it's gone/settled/paid off.
    const [invoice] = await db
      .select({
        id: travelInvoices.id,
        guardianId: travelInvoices.guardianId,
        balanceCents: travelInvoices.balanceCents,
        status: travelInvoices.status,
      })
      .from(travelInvoices)
      .where(eq(travelInvoices.id, charge.invoiceId))
      .limit(1);

    if (
      !invoice ||
      FINAL_INVOICE_STATUSES.has(invoice.status) ||
      invoice.balanceCents <= 0
    ) {
      await db
        .update(travelScheduledCharges)
        .set({ status: "cancelled" })
        .where(eq(travelScheduledCharges.id, charge.id));
      summary.cancelled += 1;
      continue;
    }

    // (3) Resolve the Stripe customer + the guardian's DEFAULT saved card.
    const guardianId = invoice.guardianId;
    let customerId: string | null = null;
    if (guardianId) {
      const [guardian] = await db
        .select({ stripeCustomerId: travelGuardians.stripeCustomerId })
        .from(travelGuardians)
        .where(eq(travelGuardians.id, guardianId))
        .limit(1);
      customerId = guardian?.stripeCustomerId ?? null;
    }

    let paymentMethodId: string | null = null;
    if (guardianId) {
      // Default card = isDefault DESC, then oldest first as the tiebreak.
      const [pm] = await db
        .select({
          stripePaymentMethodId: travelPaymentMethods.stripePaymentMethodId,
        })
        .from(travelPaymentMethods)
        .where(eq(travelPaymentMethods.guardianId, guardianId))
        .orderBy(
          desc(travelPaymentMethods.isDefault),
          asc(travelPaymentMethods.createdAt),
        )
        .limit(1);
      paymentMethodId = pm?.stripePaymentMethodId ?? null;
    }

    if (!guardianId || !customerId || !paymentMethodId) {
      await db
        .update(travelScheduledCharges)
        .set({
          status: "failed",
          failureReason: "no_payment_method",
          attemptCount: charge.attemptCount + 1,
        })
        .where(eq(travelScheduledCharges.id, charge.id));
      summary.failed += 1;
      continue;
    }

    // (4) Clamp to the live balance — never charge more than is owed.
    const amountCents = clampChargeAmountCents(
      charge.amountCents,
      invoice.balanceCents,
    );

    // (5) Charge off-session. The metadata rides onto the PI so the webhook can
    // record the payment, reduce the balance, mark the installment paid, and flip
    // this charge to 'charged'. The runner itself writes NEITHER the balance nor
    // the 'charged' status (that would risk a double-write with the webhook).
    const metadata: Record<string, string> = {
      kind: "installment",
      invoiceId: invoice.id,
      guardianId,
      scheduledChargeId: charge.id,
    };
    if (charge.installmentId) metadata.installmentId = charge.installmentId;

    try {
      const pi = await createOffSessionPaymentIntent(
        {
          customerId,
          paymentMethodId,
          amountCents,
          metadata,
        },
        `schedcharge_${charge.id}`,
      );
      // Success → INITIATE only: stamp stripe_ref for traceability. The webhook
      // does the money write + status→'charged'.
      await db
        .update(travelScheduledCharges)
        .set({ stripeRef: pi.id })
        .where(eq(travelScheduledCharges.id, charge.id));
      summary.initiated += 1;
    } catch (err) {
      if (err instanceof StripeError) {
        // A decline / authentication_required — mark failed, record the reason,
        // bump the attempt counter. Do NOT rethrow: one decline must not abort
        // the rest of the batch.
        const reason = (err.stripeCode ?? err.stripeType ?? "charge_failed").slice(
          0,
          120,
        );
        await db
          .update(travelScheduledCharges)
          .set({
            status: "failed",
            failureReason: reason,
            attemptCount: charge.attemptCount + 1,
          })
          .where(eq(travelScheduledCharges.id, charge.id));
        summary.failed += 1;
        continue;
      }
      // NON-StripeError (unexpected/infra) — surface it. The row stays claimed
      // (claimed_at set, status still 'scheduled'), so it won't be re-picked by a
      // later run; an operator resolves it deliberately.
      throw err;
    }
  }

  return summary;
}
