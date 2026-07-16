// Block 3d-1: the OPERATOR product-catalog data layer. This is the write side of
// the Block-3 registration story — until now travel_products rows only existed
// via DB seeding; these functions are the surface that CREATES / EDITS / ARCHIVES
// them for real (operator-only; the routes guard with requireTravelAccess).
//
// It is a NEW file, deliberately separate from the CONSUMER engine
// (src/travel/registration.ts) — we do NOT duplicate that engine. We reuse its
// REGISTERABLE_TRAVEL_PRODUCT_TYPES allowlist so the operator's "type" select and
// the parent-facing registration allowlist can never drift.
//
// MONEY SAFETY: every function here takes/returns integer CENTS. The operator
// enters DOLLARS in the UI; the server ACTION (never these functions) parses +
// rounds the dollar strings to cents before calling in. A product has EXACTLY one
// price source — flat (basePriceCents, priceTiers null) XOR tiered (a non-empty
// priceTiers array, basePriceCents null) — matching what the consumer engine
// expects when it re-resolves a price. Neither/both is rejected.
//
// DRIVER: neon-http (drizzle) — NO interactive db.transaction. All writes here
// are single-row inserts/updates (no batch needed). Ids come from the schema's
// $defaultFn(() => crypto.randomUUID()).

import { asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  travelAthletes,
  travelGuardians,
  travelInvoices,
  travelLocations,
  travelPayments,
  travelProducts,
  travelRefunds,
  travelSeasons,
  travelTeams,
} from "@/db/schema";
import type { TravelProductPriceTier } from "@/db/schema";
import { REGISTERABLE_TRAVEL_PRODUCT_TYPES } from "@/travel/registration";

// ---------------------------------------------------------------------------
// Product types for the operator form.
// ---------------------------------------------------------------------------

// The full set the operator may create. The registerable subset (what parents
// can self-register INTO) comes straight from the engine's allowlist so the two
// can never diverge; the rest are operator-only catalog kinds (uniform sales,
// memberships, tournaments, misc). Deduped in case an engine type overlaps.
export const PRODUCT_TYPES = Array.from(
  new Set<string>([
    ...REGISTERABLE_TRAVEL_PRODUCT_TYPES,
    "uniform",
    "membership",
    "tournament",
    "other",
  ]),
) as readonly string[];

export type ProductType = (typeof PRODUCT_TYPES)[number];

// The registerable subset, re-exported for the UI so it can flag which types a
// parent can actually register for (display hint only — the engine is the guard).
export const REGISTERABLE_TYPES = new Set<string>(
  REGISTERABLE_TRAVEL_PRODUCT_TYPES as readonly string[],
);

// ---------------------------------------------------------------------------
// Reads.
// ---------------------------------------------------------------------------

export type OperatorCatalogProduct = {
  id: string;
  name: string;
  type: string;
  active: boolean;
  basePriceCents: number | null;
  priceTiers: TravelProductPriceTier[] | null;
  description: string | null;
  seasonId: string | null;
  locationId: string | null;
  teamId: string | null;
  seasonName: string | null;
  locationName: string | null;
  teamName: string | null;
};

/**
 * ALL products (active AND archived) for the operator catalog list, each with
 * resolved season / location / team NAMES via LEFT JOINs (so a product with a
 * null or set-null'd FK still lists). Sorted active-first, then by name.
 */
export async function listAllTravelProductsForOperator(): Promise<
  OperatorCatalogProduct[]
> {
  const rows = await db
    .select({
      id: travelProducts.id,
      name: travelProducts.name,
      type: travelProducts.type,
      active: travelProducts.active,
      basePriceCents: travelProducts.basePriceCents,
      priceTiers: travelProducts.priceTiers,
      description: travelProducts.description,
      seasonId: travelProducts.seasonId,
      locationId: travelProducts.locationId,
      teamId: travelProducts.teamId,
      seasonName: travelSeasons.name,
      locationName: travelLocations.name,
      teamName: travelTeams.name,
    })
    .from(travelProducts)
    .leftJoin(travelSeasons, eq(travelSeasons.id, travelProducts.seasonId))
    .leftJoin(travelLocations, eq(travelLocations.id, travelProducts.locationId))
    .leftJoin(travelTeams, eq(travelTeams.id, travelProducts.teamId));

  return rows
    .map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      active: r.active,
      basePriceCents: r.basePriceCents,
      priceTiers: r.priceTiers ?? null,
      description: r.description,
      seasonId: r.seasonId,
      locationId: r.locationId,
      teamId: r.teamId,
      seasonName: r.seasonName,
      locationName: r.locationName,
      teamName: r.teamName,
    }))
    .sort((a, b) => {
      // Active first, then alphabetical by name.
      if (a.active !== b.active) return a.active ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

export type TravelProductRow = {
  id: string;
  name: string;
  type: string;
  active: boolean;
  basePriceCents: number | null;
  priceTiers: TravelProductPriceTier[] | null;
  depositCents: number | null;
  monthlyInstallmentCents: number | null;
  description: string | null;
  seasonId: string | null;
  locationId: string | null;
  teamId: string | null;
};

/**
 * One product's raw row (for the edit form), or null if the id doesn't exist.
 */
export async function getTravelProduct(
  id: string,
): Promise<TravelProductRow | null> {
  const [row] = await db
    .select({
      id: travelProducts.id,
      name: travelProducts.name,
      type: travelProducts.type,
      active: travelProducts.active,
      basePriceCents: travelProducts.basePriceCents,
      priceTiers: travelProducts.priceTiers,
      depositCents: travelProducts.depositCents,
      monthlyInstallmentCents: travelProducts.monthlyInstallmentCents,
      description: travelProducts.description,
      seasonId: travelProducts.seasonId,
      locationId: travelProducts.locationId,
      teamId: travelProducts.teamId,
    })
    .from(travelProducts)
    .where(eq(travelProducts.id, id))
    .limit(1);

  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    active: row.active,
    basePriceCents: row.basePriceCents,
    priceTiers: row.priceTiers ?? null,
    depositCents: row.depositCents,
    monthlyInstallmentCents: row.monthlyInstallmentCents,
    description: row.description,
    seasonId: row.seasonId,
    locationId: row.locationId,
    teamId: row.teamId,
  };
}

export type ProductFormOptions = {
  seasons: { id: string; name: string }[];
  locations: { id: string; name: string }[];
  teams: { id: string; name: string }[];
};

/**
 * The option lists for the create/edit form's season / location / team selects.
 * Teams are the auto-roster target (a product tied to a team rosters the athlete
 * on registration). All three sorted by name.
 */
export async function getProductFormOptions(): Promise<ProductFormOptions> {
  const [seasons, locations, teams] = await Promise.all([
    db
      .select({ id: travelSeasons.id, name: travelSeasons.name })
      .from(travelSeasons)
      .orderBy(asc(travelSeasons.name)),
    db
      .select({ id: travelLocations.id, name: travelLocations.name })
      .from(travelLocations)
      .orderBy(asc(travelLocations.name)),
    db
      .select({ id: travelTeams.id, name: travelTeams.name })
      .from(travelTeams)
      .orderBy(asc(travelTeams.name)),
  ]);
  return { seasons, locations, teams };
}

// ---------------------------------------------------------------------------
// Writes (create / update / archive). All take integer CENTS.
// ---------------------------------------------------------------------------

export type CatalogWriteError =
  | "name_required"
  | "bad_type"
  | "price_required"
  | "bad_reference";

export type CatalogWriteResult =
  | { ok: true; id: string }
  | { ok: false; error: CatalogWriteError };

export type ProductInput = {
  name: string;
  type: string;
  seasonId: string | null;
  locationId: string | null;
  teamId: string | null;
  description: string | null;
  priceMode: "flat" | "tiered";
  // Present only for priceMode === "flat" (integer cents, non-negative).
  basePriceCents?: number;
  // Present only for priceMode === "tiered" (non-empty; each priceCents integer).
  priceTiers?: TravelProductPriceTier[];
  // Block 4d (additive, OPTIONAL): the up-front deposit amount in integer cents
  // (what the deposit-checkout charges first). Absent/blank → no deposit set
  // (the deposit flow then falls back to the full balance). Same nullable style
  // as monthlyInstallmentCents; a non-non-negative-int value normalizes to null.
  depositCents?: number | null;
  // Block 4b-2-b-2 (additive, OPTIONAL): the fixed monthly installment amount in
  // integer cents. Absent/blank → no monthly plan can be minted. Same nullable
  // style as depositCents; a non-non-negative-int value normalizes to null.
  monthlyInstallmentCents?: number | null;
  active: boolean;
};

// A normalized, storage-ready price source: EXACTLY one of the two columns is
// set, the other is null (the flat-XOR-tiered invariant, enforced once here).
type ValidatedPrice =
  | { basePriceCents: number; priceTiers: null }
  | { basePriceCents: null; priceTiers: TravelProductPriceTier[] };

function isNonNegativeInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0;
}

// Normalize an OPTIONAL cents field (monthly installment): a non-negative integer
// passes through; anything else (null/undefined/negative/non-integer) → null.
// The operator's monthly amount is optional, so an absent/invalid value simply
// means "no monthly plan available" rather than a hard validation failure.
function normalizeOptionalCents(n: number | null | undefined): number | null {
  return isNonNegativeInt(n) ? n : null;
}

// Validate + normalize the price source per the flat-XOR-tiered rule. Returns
// null (→ price_required) when the active mode's data is missing/invalid.
function validatePrice(input: ProductInput): ValidatedPrice | null {
  if (input.priceMode === "flat") {
    if (!isNonNegativeInt(input.basePriceCents)) return null;
    return { basePriceCents: input.basePriceCents, priceTiers: null };
  }

  // Tiered: a non-empty array; every tier well-formed; keys unique.
  const tiers = input.priceTiers ?? [];
  if (tiers.length === 0) return null;

  const seen = new Set<string>();
  const normalized: TravelProductPriceTier[] = [];
  for (const t of tiers) {
    const key = (t?.key ?? "").trim();
    const label = (t?.label ?? "").trim();
    if (!key || !label) return null;
    if (!isNonNegativeInt(t?.priceCents)) return null;
    if (seen.has(key)) return null; // keys must be unique
    seen.add(key);
    normalized.push({ key, label, priceCents: t.priceCents });
  }
  return { basePriceCents: null, priceTiers: normalized };
}

// Confirm each provided FK id references an existing row. Absent (null) ids are
// allowed (the columns are nullable). Returns false → bad_reference.
async function referencesExist(input: {
  seasonId: string | null;
  locationId: string | null;
  teamId: string | null;
}): Promise<boolean> {
  if (input.seasonId) {
    const [s] = await db
      .select({ id: travelSeasons.id })
      .from(travelSeasons)
      .where(eq(travelSeasons.id, input.seasonId))
      .limit(1);
    if (!s) return false;
  }
  if (input.locationId) {
    const [l] = await db
      .select({ id: travelLocations.id })
      .from(travelLocations)
      .where(eq(travelLocations.id, input.locationId))
      .limit(1);
    if (!l) return false;
  }
  if (input.teamId) {
    const [t] = await db
      .select({ id: travelTeams.id })
      .from(travelTeams)
      .where(eq(travelTeams.id, input.teamId))
      .limit(1);
    if (!t) return false;
  }
  return true;
}

// Shared server-side validation for create + update. Returns a ready price
// source on success, or an error code on the first failing rule.
async function validateProductInput(
  input: ProductInput,
): Promise<
  | { ok: true; name: string; price: ValidatedPrice }
  | { ok: false; error: CatalogWriteError }
> {
  const name = input.name.trim();
  if (!name) return { ok: false, error: "name_required" };

  if (!PRODUCT_TYPES.includes(input.type)) {
    return { ok: false, error: "bad_type" };
  }

  const price = validatePrice(input);
  if (!price) return { ok: false, error: "price_required" };

  const refsOk = await referencesExist({
    seasonId: input.seasonId,
    locationId: input.locationId,
    teamId: input.teamId,
  });
  if (!refsOk) return { ok: false, error: "bad_reference" };

  return { ok: true, name, price };
}

/**
 * Create a product. Validates name / type / price (flat XOR tiered) / FK
 * references server-side. Money is integer cents throughout — the ACTION has
 * already converted the operator's dollar strings. Single-row insert (neon-http:
 * no transaction). Id from the schema $defaultFn.
 */
export async function createTravelProduct(
  input: ProductInput,
): Promise<CatalogWriteResult> {
  const valid = await validateProductInput(input);
  if (!valid.ok) return valid;

  const id = crypto.randomUUID();
  await db.insert(travelProducts).values({
    id,
    type: input.type,
    name: valid.name,
    locationId: input.locationId,
    seasonId: input.seasonId,
    teamId: input.teamId,
    basePriceCents: valid.price.basePriceCents,
    priceTiers: valid.price.priceTiers,
    depositCents: normalizeOptionalCents(input.depositCents),
    monthlyInstallmentCents: normalizeOptionalCents(input.monthlyInstallmentCents),
    description: input.description,
    active: input.active,
  });

  return { ok: true, id };
}

/**
 * Update an existing product. Same validation as create. Writes BOTH price
 * columns every time (one to the value, the other to null) so switching modes
 * can't leave a stale column set — the flat-XOR-tiered invariant holds on every
 * save. Single-row update.
 */
export async function updateTravelProduct(
  id: string,
  input: ProductInput,
): Promise<CatalogWriteResult> {
  const valid = await validateProductInput(input);
  if (!valid.ok) return valid;

  await db
    .update(travelProducts)
    .set({
      type: input.type,
      name: valid.name,
      locationId: input.locationId,
      seasonId: input.seasonId,
      teamId: input.teamId,
      basePriceCents: valid.price.basePriceCents,
      priceTiers: valid.price.priceTiers,
      depositCents: normalizeOptionalCents(input.depositCents),
      monthlyInstallmentCents: normalizeOptionalCents(
        input.monthlyInstallmentCents,
      ),
      description: input.description,
      active: input.active,
    })
    .where(eq(travelProducts.id, id));

  return { ok: true, id };
}

export type SetActiveResult =
  | { ok: true }
  | { ok: false; error: "not_found" };

/**
 * Archive (active=false) or reactivate (active=true) a product. A no-op on a
 * missing id is surfaced as not_found so the action can banner it.
 */
export async function setTravelProductActive(
  id: string,
  active: boolean,
): Promise<SetActiveResult> {
  const [existing] = await db
    .select({ id: travelProducts.id })
    .from(travelProducts)
    .where(eq(travelProducts.id, id))
    .limit(1);
  if (!existing) return { ok: false, error: "not_found" };

  await db
    .update(travelProducts)
    .set({ active })
    .where(eq(travelProducts.id, id));

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Block 3d-2 — operator REGISTRATION / DUES visibility (read-only).
//
// Each Block-3c registration created exactly ONE invoice carrying its
// guardian + athlete + product + amount, so the invoice list doubles as the
// registration list ("who registered and what they owe"). This is a READ-ONLY
// surface — recording payments is Block 4. Money stays integer CENTS; the route
// formats to USD for display only.
// ---------------------------------------------------------------------------

export type OperatorInvoice = {
  id: string;
  createdAt: Date;
  guardianName: string | null;
  guardianEmail: string | null;
  athleteName: string | null;
  productName: string | null;
  teamName: string | null;
  totalCents: number;
  balanceCents: number;
  status: string;
};

// The invoice status values (text) — for the tab filter + badge mapping.
export const TRAVEL_INVOICE_STATUSES = [
  "pending",
  "scheduled",
  "partial",
  "paid",
  "refunded",
  "void",
] as const;

// Join first/last into a display name; a fully-null pair (set-null'd FK) → null
// so the UI can render "—".
function joinName(
  first: string | null,
  last: string | null,
): string | null {
  const name = [first, last].filter(Boolean).join(" ").trim();
  return name.length > 0 ? name : null;
}

/**
 * Invoices for the operator registration/dues list, each with resolved
 * guardian / athlete / product / team display names via LEFT JOINs (a
 * set-null'd FK still lists, name shown as null → "—" in the UI). Optional
 * status filter: any value other than "all" narrows to that exact status.
 * Ordered newest-first.
 */
export async function listTravelInvoicesForOperator(
  status?: string,
): Promise<OperatorInvoice[]> {
  const base = db
    .select({
      id: travelInvoices.id,
      createdAt: travelInvoices.createdAt,
      guardianFirstName: travelGuardians.firstName,
      guardianLastName: travelGuardians.lastName,
      guardianEmail: travelGuardians.email,
      athleteFirstName: travelAthletes.firstName,
      athleteLastName: travelAthletes.lastName,
      productName: travelProducts.name,
      teamName: travelTeams.name,
      totalCents: travelInvoices.totalCents,
      balanceCents: travelInvoices.balanceCents,
      status: travelInvoices.status,
    })
    .from(travelInvoices)
    .leftJoin(
      travelGuardians,
      eq(travelGuardians.id, travelInvoices.guardianId),
    )
    .leftJoin(travelAthletes, eq(travelAthletes.id, travelInvoices.athleteId))
    .leftJoin(travelProducts, eq(travelProducts.id, travelInvoices.productId))
    .leftJoin(travelTeams, eq(travelTeams.id, travelProducts.teamId));

  const filtered =
    status && status !== "all"
      ? base.where(eq(travelInvoices.status, status))
      : base;

  const rows = await filtered.orderBy(desc(travelInvoices.createdAt));

  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    guardianName: joinName(r.guardianFirstName, r.guardianLastName),
    guardianEmail: r.guardianEmail,
    athleteName: joinName(r.athleteFirstName, r.athleteLastName),
    productName: r.productName,
    teamName: r.teamName,
    totalCents: r.totalCents,
    balanceCents: r.balanceCents,
    status: r.status,
  }));
}

export type TravelInvoiceStatusCounts = {
  all: number;
} & Record<string, number>;

/**
 * Per-status invoice counts (one cheap grouped query) plus an "all" total, so
 * the operator tabs can show a count beside each status. Every known status
 * appears (defaulted to 0) even when it has no rows.
 */
export async function getTravelInvoiceStatusCounts(): Promise<TravelInvoiceStatusCounts> {
  const rows = await db
    .select({
      status: travelInvoices.status,
      count: sql<number>`count(*)::int`,
    })
    .from(travelInvoices)
    .groupBy(travelInvoices.status);

  const counts: TravelInvoiceStatusCounts = { all: 0 };
  for (const s of TRAVEL_INVOICE_STATUSES) counts[s] = 0;

  for (const r of rows) {
    counts[r.status] = (counts[r.status] ?? 0) + r.count;
    counts.all += r.count;
  }

  return counts;
}

// ---------------------------------------------------------------------------
// Block 4d — operator PAYMENTS + REFUNDS visibility (read-only). The write side
// (issuing a refund) is the already-built + tested refundPayment engine, wired
// by src/app/travel/admin/payments/actions.ts. This read is the list the
// operator refund surface renders. Money stays integer CENTS; the route formats
// to USD for display only. READ-ONLY (no batch / no transaction — neon-http).
// ---------------------------------------------------------------------------

export type OperatorPayment = {
  id: string;
  guardianName: string | null;
  guardianEmail: string | null;
  productName: string | null;
  amountCents: number;
  channel: string;
  status: string;
  paidAt: Date | null;
  stripeChargeId: string | null;
  // SUM of every travelRefunds row against this payment (0 when none).
  refundedCents: number;
  // Still-refundable remainder: (amount − refunded) for a succeeded payment,
  // else 0 (a pending/failed/already-fully-refunded payment can't be refunded).
  refundableCents: number;
};

/**
 * Payments for the operator payments/refunds list, each with resolved
 * guardian (payment→guardian) + product (payment→invoice→product) display
 * fields via LEFT JOINs, plus the aggregated refunded-so-far total via a scalar
 * subquery over travelRefunds. refundableCents is derived per the succeeded-only
 * rule. Newest-first (paidAt then createdAt). Default limit 100. Read-only.
 */
export async function listTravelPaymentsForOperator(opts?: {
  limit?: number;
}): Promise<OperatorPayment[]> {
  const limit = opts?.limit ?? 100;

  const rows = await db
    .select({
      id: travelPayments.id,
      guardianFirstName: travelGuardians.firstName,
      guardianLastName: travelGuardians.lastName,
      guardianEmail: travelGuardians.email,
      productName: travelProducts.name,
      amountCents: travelPayments.amountCents,
      channel: travelPayments.channel,
      status: travelPayments.status,
      paidAt: travelPayments.paidAt,
      stripeChargeId: travelPayments.stripeChargeId,
      // Aggregate the immutable refund rows for THIS payment (0 when none).
      refundedCents: sql<number>`coalesce((select sum(${travelRefunds.amountCents}) from ${travelRefunds} where ${travelRefunds.paymentId} = ${travelPayments.id}), 0)::int`,
    })
    .from(travelPayments)
    .leftJoin(
      travelGuardians,
      eq(travelGuardians.id, travelPayments.guardianId),
    )
    .leftJoin(travelInvoices, eq(travelInvoices.id, travelPayments.invoiceId))
    .leftJoin(travelProducts, eq(travelProducts.id, travelInvoices.productId))
    .orderBy(desc(travelPayments.paidAt), desc(travelPayments.createdAt))
    .limit(limit);

  return rows.map((r) => {
    const refundedCents = r.refundedCents ?? 0;
    // Only a succeeded payment is refundable; clamp at 0 so a fully-refunded
    // (status still 'succeeded' on a partial history) row never goes negative.
    const refundableCents =
      r.status === "succeeded"
        ? Math.max(0, r.amountCents - refundedCents)
        : 0;
    return {
      id: r.id,
      guardianName: joinName(r.guardianFirstName, r.guardianLastName),
      guardianEmail: r.guardianEmail,
      productName: r.productName,
      amountCents: r.amountCents,
      channel: r.channel,
      status: r.status,
      paidAt: r.paidAt,
      stripeChargeId: r.stripeChargeId,
      refundedCents,
      refundableCents,
    };
  });
}
