// Travel (Block 4b-2-b-2) — MONTHLY PAYMENT-PLAN CREATION. The model (locked with
// the client): the deposit locks the spot, then the remaining season balance is
// collected as a FIXED MONTHLY AMOUNT (operator-set per product, the same nullable
// pattern as depositCents) auto-charged to the card on file until paid off; the
// LAST installment is the remainder.
//
// THIS FILE mints the plan ONLY. It does NOT charge anything: it splits the
// balance into installments, writes the travelPaymentPlans row + N
// travelInstallments + N DUE travelScheduledCharges, and returns. The existing
// off-session charging engine (scheduled-charges.ts) later executes each due
// scheduled_charge; the signature-verified webhook (payments.ts) settles the
// money. Keeping creation separate from charging is what keeps money-writes in one
// place.
//
// The pure splitter (computeMonthlyInstallments) + the month helper (addMonths)
// carry NO DB/Stripe/I-O and are unit-tested exhaustively (plans.test.ts). The
// impure engine (createMonthlyPlanForInvoice) is live-proven by the Orchestrator.
//
// neon-http: NO db.transaction. The multi-row write goes through ONE db.batch,
// with ALL ids pre-generated (crypto.randomUUID) so the installment↔scheduled_
// charge linkage is set WITHOUT .returning() inside the batch. Mirrors payments.ts.

import { and, eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { db } from "@/db";
import {
  travelInstallments,
  travelInvoices,
  travelPaymentMethods,
  travelPaymentPlans,
  travelProducts,
  travelScheduledCharges,
} from "@/db/schema";

// Invoice statuses that are FINAL — no new plan is minted against them. Mirrors
// payments.ts / scheduled-charges.ts FINAL_STATUSES.
const FINAL_STATUSES = new Set(["paid", "void", "refunded"]);

// ---------------------------------------------------------------------------
// Pure month math + installment split (integer cents; loud throws on caller bugs).
// ---------------------------------------------------------------------------

/**
 * Add `n` calendar months to `date`, CLAMPING the day-of-month on overflow so a
 * short target month can't roll into the next one (e.g. Jan 31 + 1mo → Feb 28,
 * not Mar 3). Time-of-day is preserved. Pure — no mutation of the input Date.
 * `n` may be negative. setFullYear(y, m, d) assigns all three atomically, so a
 * clamped day never triggers JS's own month rollover.
 */
export function addMonths(date: Date, n: number): Date {
  const targetMonthIndex = date.getMonth() + n;
  const targetYear = date.getFullYear() + Math.floor(targetMonthIndex / 12);
  const normalizedMonth = ((targetMonthIndex % 12) + 12) % 12;
  // Last day of the target month: day 0 of the FOLLOWING month.
  const lastDayOfTargetMonth = new Date(
    targetYear,
    normalizedMonth + 1,
    0,
  ).getDate();
  const clampedDay = Math.min(date.getDate(), lastDayOfTargetMonth);
  const result = new Date(date.getTime());
  result.setFullYear(targetYear, normalizedMonth, clampedDay);
  return result;
}

/** Add exactly one calendar month (day-clamped). Convenience over addMonths(d, 1). */
export function addOneMonth(date: Date): Date {
  return addMonths(date, 1);
}

export type MonthlyInstallment = {
  seq: number;
  dueDate: Date;
  amountCents: number;
};

/**
 * Split `balanceCents` into fixed monthly installments of `monthlyCents` each,
 * the LAST being the remainder (`balanceCents % monthlyCents`; a full
 * `monthlyCents` when it divides evenly). PURE.
 *
 *   - `seq` is 1-based.
 *   - `dueDate` = `startDate` + (seq-1) calendar months (day-clamped via addMonths).
 *   - balance 125000, monthly 25000 → 5 × 25000 (even).
 *   - balance 130000, monthly 25000 → 5 × 25000 + 1 × 5000 (remainder tail).
 *   - balance < monthly → a single installment = the whole balance.
 *
 * SUM(amountCents) === balanceCents always. Throws on balanceCents ≤ 0 or
 * monthlyCents ≤ 0 (a caller bug), and on non-integer cents (money must be whole
 * cents) — surfacing is safer than silently mis-splitting.
 */
export function computeMonthlyInstallments(
  balanceCents: number,
  monthlyCents: number,
  startDate: Date,
): MonthlyInstallment[] {
  if (!Number.isInteger(balanceCents)) {
    throw new Error(
      `computeMonthlyInstallments: balanceCents ${balanceCents} must be an integer`,
    );
  }
  if (!Number.isInteger(monthlyCents)) {
    throw new Error(
      `computeMonthlyInstallments: monthlyCents ${monthlyCents} must be an integer`,
    );
  }
  if (balanceCents <= 0) {
    throw new Error(
      `computeMonthlyInstallments: balanceCents ${balanceCents} must be > 0`,
    );
  }
  if (monthlyCents <= 0) {
    throw new Error(
      `computeMonthlyInstallments: monthlyCents ${monthlyCents} must be > 0`,
    );
  }

  const fullCount = Math.floor(balanceCents / monthlyCents);
  const remainder = balanceCents % monthlyCents;

  const installments: MonthlyInstallment[] = [];
  for (let i = 0; i < fullCount; i++) {
    installments.push({
      seq: i + 1,
      dueDate: addMonths(startDate, i),
      amountCents: monthlyCents,
    });
  }
  if (remainder > 0) {
    installments.push({
      seq: fullCount + 1,
      dueDate: addMonths(startDate, fullCount),
      amountCents: remainder,
    });
  }
  return installments;
}

// ---------------------------------------------------------------------------
// createMonthlyPlanForInvoice — the impure engine. Mints a monthly plan for ONE
// invoice: validates it's plannable, splits the balance, and writes the plan +
// installments + DUE scheduled charges in ONE db.batch. Charges NOTHING.
// ---------------------------------------------------------------------------

export type CreateMonthlyPlanResult =
  | { ok: true; planId: string; installments: number }
  | {
      ok: false;
      error:
        | "not_found"
        | "no_monthly_amount"
        | "not_payable"
        | "already_planned"
        | "no_default_card";
    };

/**
 * Mint the fixed-monthly plan for `invoiceId`:
 *   1. Load the invoice (+ its product's monthlyInstallmentCents via productId).
 *      Missing → not_found.
 *   2. Final-status or ≤0 balance → not_payable.
 *   3. No operator monthly amount (null/≤0) → no_monthly_amount.
 *   4. A plan already exists for this invoice → already_planned (no double-create).
 *   5. The guardian must have a saved card (autopay needs a vaulted card) →
 *      else no_default_card. [Read-only check.]
 *   6. Split the balance starting ONE MONTH AFTER enrollment (the deposit covered
 *      "now"), then in ONE db.batch write the plan + N installments + N due
 *      scheduled charges (all ids pre-generated so the installment↔charge linkage
 *      is set without .returning()).
 */
export async function createMonthlyPlanForInvoice(params: {
  invoiceId: string;
  startDate?: Date;
}): Promise<CreateMonthlyPlanResult> {
  // (1) Invoice + its product's monthly amount (leftJoin: a null productId still
  // returns the invoice, monthly amount null → no_monthly_amount below).
  const [invoice] = await db
    .select({
      id: travelInvoices.id,
      guardianId: travelInvoices.guardianId,
      balanceCents: travelInvoices.balanceCents,
      status: travelInvoices.status,
      monthlyInstallmentCents: travelProducts.monthlyInstallmentCents,
    })
    .from(travelInvoices)
    .leftJoin(travelProducts, eq(travelProducts.id, travelInvoices.productId))
    .where(eq(travelInvoices.id, params.invoiceId))
    .limit(1);

  if (!invoice) return { ok: false, error: "not_found" };

  // (2) Nothing to collect on a settled/void invoice or a zero/negative balance.
  if (FINAL_STATUSES.has(invoice.status) || invoice.balanceCents <= 0) {
    return { ok: false, error: "not_payable" };
  }

  // (3) The operator must have set a monthly amount on the product.
  const monthlyCents = invoice.monthlyInstallmentCents;
  if (monthlyCents == null || monthlyCents <= 0) {
    return { ok: false, error: "no_monthly_amount" };
  }

  // (4) Don't double-create: one plan per invoice.
  const [existingPlan] = await db
    .select({ id: travelPaymentPlans.id })
    .from(travelPaymentPlans)
    .where(eq(travelPaymentPlans.invoiceId, invoice.id))
    .limit(1);
  if (existingPlan) return { ok: false, error: "already_planned" };

  // (5) Autopay needs a vaulted card. Prefer the default, else any saved card.
  // A guardian-less invoice (set-null'd FK) can't have a card → no_default_card.
  if (!invoice.guardianId) return { ok: false, error: "no_default_card" };
  const [card] = await db
    .select({ id: travelPaymentMethods.id })
    .from(travelPaymentMethods)
    .where(
      and(
        eq(travelPaymentMethods.guardianId, invoice.guardianId),
        eq(travelPaymentMethods.isDefault, true),
      ),
    )
    .limit(1);
  let hasCard = !!card;
  if (!hasCard) {
    // No explicit default — accept ANY saved card as the autopay source.
    const [anyCard] = await db
      .select({ id: travelPaymentMethods.id })
      .from(travelPaymentMethods)
      .where(eq(travelPaymentMethods.guardianId, invoice.guardianId))
      .limit(1);
    hasCard = !!anyCard;
  }
  if (!hasCard) return { ok: false, error: "no_default_card" };

  // (6) The FIRST monthly charge is due ONE MONTH AFTER enrollment — the deposit
  // already covered "now", so no immediate charge.
  // ASSUMPTION (confirm w/ Mark): first monthly charge is 1 month after
  // enrollment, not at enrollment.
  const startDate = params.startDate ?? new Date();
  const installments = computeMonthlyInstallments(
    invoice.balanceCents,
    monthlyCents,
    addOneMonth(startDate),
  );

  // Pre-generate every id so the installment↔scheduled_charge linkage is set
  // inside the batch WITHOUT .returning() (neon-http batch restriction).
  const planId = crypto.randomUUID();
  const rows = installments.map((inst) => ({
    installmentId: crypto.randomUUID(),
    scheduledChargeId: crypto.randomUUID(),
    inst,
  }));

  const statements: BatchItem<"pg">[] = [
    db.insert(travelPaymentPlans).values({
      id: planId,
      invoiceId: invoice.id,
      kind: "installments",
      nInstallments: installments.length,
      scheduleType: "monthly_fixed",
    }),
  ];
  for (const { installmentId, inst } of rows) {
    statements.push(
      db.insert(travelInstallments).values({
        id: installmentId,
        planId,
        seq: inst.seq,
        dueDate: inst.dueDate,
        amountCents: inst.amountCents,
        status: "scheduled",
      }),
    );
  }
  for (const { installmentId, scheduledChargeId, inst } of rows) {
    statements.push(
      db.insert(travelScheduledCharges).values({
        id: scheduledChargeId,
        invoiceId: invoice.id,
        // The cron resolves the guardian's default card at charge time.
        paymentMethodId: null,
        runOn: inst.dueDate,
        amountCents: inst.amountCents,
        status: "scheduled",
        installmentId,
      }),
    );
  }

  await db.batch(
    statements as [(typeof statements)[number], ...typeof statements],
  );

  return { ok: true, planId, installments: installments.length };
}
