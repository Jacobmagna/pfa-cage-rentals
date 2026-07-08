// Travel (Block 3): the deterministic PRICING ENGINE. Ported VERBATIM from
// Northstar's src/lib/billing/pricing.logic.ts (money math is not re-derived
// per build). PURE money math only — NO DB, NO Stripe, NO Date, NO I/O. Every
// function is deterministic given its inputs so the whole branch space is
// unit-tested without mocks. Integer-cents discipline: dollars NEVER enter this
// module and floats are NEVER used to carry money (Math.round collapses any
// intermediate division immediately).
//
// This engine turns a product base price + applied discounts/add-ons into:
//   1. computeInvoiceLines — signed invoice lines + a clamped total.
//
// SNAPSHOT DISCIPLINE: every adjustment becomes its OWN signed line — we never
// emit a single netted number. The line list is what an invoice snapshots; the
// total is just SUM(lines). Downstream reads the stored lines, never recomputes.
//
// SCOPE (Block 3): only the registration-path helpers are ported here —
// computeInvoiceLines / adjustmentLineAmount / resolveTierPrice. The
// deposit/installment helpers (splitDeposit / buildInstallmentSchedule) are
// Block 4 and are intentionally OMITTED.
//
// The `DiscountType` union below MIRRORS the discount `type` values in
// src/db/schema.ts (pay_full | family_sibling | financial_aid | add_on |
// custom). It is RE-DECLARED here rather than imported so this module stays
// dependency-free (no import from @/db). If those change, update both.

// --- Types -----------------------------------------------------------------

export type DiscountType =
  | "pay_full"
  | "family_sibling"
  | "financial_aid"
  | "add_on"
  | "custom";

export type AdjustmentMethod = "flat" | "percent";

/**
 * One applied discount / add-on, as handed to the engine. Mirrors a discount
 * row's shape:
 *   - method "flat"    → `amountCents` is an integer cents magnitude (required).
 *   - method "percent" → `percent` is a WHOLE-NUMBER percent (10 = 10%, required).
 *
 * `type` classifies it. `add_on` is a POSITIVE surcharge (e.g. the +$600 add-on);
 * every other type is a REDUCTION. `name` is the human label that becomes the
 * line description.
 */
export type PricingAdjustment = {
  type: DiscountType;
  method: AdjustmentMethod;
  // Required for method "flat"; ignored for "percent".
  amountCents?: number;
  // Required for method "percent" (a whole-number percent); ignored for "flat".
  percent?: number;
  name: string;
};

/** One signed invoice line. Negative magnitude for reductions. */
export type PricingLine = {
  description: string;
  amountCents: number;
};

export type InvoiceComputation = {
  lines: PricingLine[];
  totalCents: number;
};

// --- 1) Invoice lines + total ----------------------------------------------

// LOCKED STACKING ORDER (default — kept centralized + easy to change later):
//
//   1. BASE price line.
//   2. ADD-ONS: every `add_on` adjustment, each as its own POSITIVE line.
//      These raise the subtotal that reductions are then applied to.
//   3. FLAT REDUCTIONS: every flat-method reduction (family_sibling,
//      financial_aid, and flat pay_full / custom), each as its own NEGATIVE
//      line, applied to the post-add-on subtotal.
//   4. PERCENT REDUCTIONS LAST: every percent-method reduction, each as its own
//      NEGATIVE line, computed on the POST-FLAT subtotal (i.e. base + add-ons −
//      flat reductions). Percents therefore compound onto whatever the flat
//      reductions already took off, NOT onto the gross.
//
// Each adjustment is ALWAYS its own signed line (snapshot discipline — never a
// single netted number). The four phases are encoded as `ADJUSTMENT_PHASES`
// below so re-ordering later is a one-line change, not a logic rewrite.

// The deterministic phase order. To change the locked stacking rule, reorder
// this array (and/or the predicates) — the engine walks phases in this order.
const ADJUSTMENT_PHASES: ReadonlyArray<(a: PricingAdjustment) => boolean> = [
  // Phase 2: positive add-ons (any method).
  (a) => a.type === "add_on",
  // Phase 3: flat-method reductions.
  (a) => a.type !== "add_on" && a.method === "flat",
  // Phase 4: percent-method reductions.
  (a) => a.type !== "add_on" && a.method === "percent",
];

/**
 * Turn a base price + applied adjustments into signed invoice lines and a
 * clamped total, following the LOCKED stacking order documented above.
 *
 * Percent rounding rule: a percent reduction line is
 *   `-Math.round(subtotal * percent / 100)`
 * where `subtotal` is the running total AFTER base + add-ons + all flat
 * reductions (the post-flat subtotal). Math.round is half-up on the cents, so a
 * fractional cent rounds to the nearest whole cent — deterministic and
 * symmetric across the engine.
 *
 * `totalCents` = SUM(lines). It is CLAMPED at 0: a stack of reductions can never
 * drive an invoice negative (we never owe the customer money here). Clamping is
 * silent — an over-discounted invoice simply lands at $0.
 *
 * Throws on a negative base price, or a malformed adjustment (a flat adjustment
 * with no/negative-typed `amountCents`, or a percent adjustment with no
 * `percent`). Surfacing these is safer than silently mis-billing.
 */
export function computeInvoiceLines(input: {
  basePriceCents: number;
  baseDescription?: string;
  adjustments: PricingAdjustment[];
}): InvoiceComputation {
  const { basePriceCents, adjustments } = input;

  if (!Number.isInteger(basePriceCents)) {
    throw new Error("computeInvoiceLines: basePriceCents must be an integer");
  }
  if (basePriceCents < 0) {
    throw new Error("computeInvoiceLines: basePriceCents must be >= 0");
  }

  const baseDescription = input.baseDescription ?? "Base price";
  const lines: PricingLine[] = [{ description: baseDescription, amountCents: basePriceCents }];

  // Running subtotal that percent reductions are computed against. Starts at
  // the base and grows/shrinks as each phase's lines are appended.
  let subtotal = basePriceCents;

  for (const matches of ADJUSTMENT_PHASES) {
    for (const adj of adjustments) {
      if (!matches(adj)) continue;
      const amount = adjustmentLineAmount(adj, subtotal);
      lines.push({ description: adj.name, amountCents: amount });
      subtotal += amount;
    }
  }

  // Total is SUM(lines) — clamped so reductions can never go negative.
  const summed = lines.reduce((n, l) => n + l.amountCents, 0);
  const totalCents = Math.max(0, summed);

  return { lines, totalCents };
}

/**
 * Resolve a single adjustment into its SIGNED cents line amount, given the
 * running subtotal (used only for percents). add_on → positive; everything else
 * → negative. Validates the method's required field.
 */
function adjustmentLineAmount(adj: PricingAdjustment, subtotal: number): number {
  const sign = adj.type === "add_on" ? 1 : -1;

  if (adj.method === "flat") {
    if (adj.amountCents == null || !Number.isInteger(adj.amountCents) || adj.amountCents < 0) {
      throw new Error(
        `computeInvoiceLines: flat adjustment "${adj.name}" needs a non-negative integer amountCents`,
      );
    }
    return sign * adj.amountCents;
  }

  // method === "percent"
  if (adj.percent == null || !Number.isFinite(adj.percent) || adj.percent < 0) {
    throw new Error(
      `computeInvoiceLines: percent adjustment "${adj.name}" needs a non-negative percent`,
    );
  }
  // Computed on the running (post-flat) subtotal; half-up cent rounding.
  return sign * Math.round((subtotal * adj.percent) / 100);
}

// --- 1b) Program price-tier resolution -------------------------------------

/**
 * One selectable program price tier. Mirrors `TravelProductPriceTier` in
 * schema.ts (same shape: key/label/priceCents) — RE-DECLARED here to keep this
 * module dependency-free of @/db. THE TWO MUST STAY IN SYNC: if the schema type
 * changes, update this type too.
 */
export type PriceTier = {
  key: string;
  label: string;
  priceCents: number;
};

export type TierResolution =
  | { ok: true; tier: PriceTier }
  | { ok: false; error: "tier_required" | "tier_not_found" };

/**
 * MONEY-CORRECTNESS CRUX: resolve which price the parent is charged from the
 * product's OWN tier config BY KEY — never a client-supplied amount.
 *
 *   - Product has NO tiers (null/empty) → no tier expected. A flat product;
 *     the caller falls back to `basePriceCents`. (`requestedKey` is ignored —
 *     returns ok=false "tier_required" only when tiers EXIST.)
 *   - Product HAS tiers, no/blank key sent → reject ("tier_required").
 *   - Product HAS tiers, key matches → return THAT tier (its server-side
 *     priceCents becomes the invoice line amount).
 *   - Product HAS tiers, key doesn't match any tier → reject ("tier_not_found").
 *
 * The returned tier's `priceCents` comes from `tiers`, never from the request,
 * so a forged/edited client price can never set the charge.
 */
export function resolveTierPrice(
  tiers: PriceTier[] | null | undefined,
  requestedKey: string | null | undefined,
): TierResolution {
  const list = tiers ?? [];
  if (list.length === 0) {
    // Flat product — no tier to resolve. Caller uses basePriceCents.
    return { ok: false, error: "tier_required" };
  }
  const key = (requestedKey ?? "").trim();
  if (key === "") return { ok: false, error: "tier_required" };
  const tier = list.find((t) => t.key === key);
  if (!tier) return { ok: false, error: "tier_not_found" };
  return { ok: true, tier };
}
