// Travel (Block 3): the CONSUMER self-serve registration ENGINE. A travel
// GUARDIAN registers their OWN athlete for a registerable product (season/team
// dues, camp, clinic, program): one atomic flow writes the registration +
// enrollment + invoice (+ lines) and — the travel-specific addition — AUTO-
// ROSTERS the athlete onto the product's team when the product carries a teamId.
//
// Ported from Northstar's src/lib/server/registration.ts
// (registerAthleteForProduct) with the REQUIRED travel adaptations:
//
//   • SESSION-NATIVE GUARDIAN: travel guardians are NOT rows in the facility
//     `users` table — the caller IS the guardian (params.guardianId is the
//     authenticated session subject). There is NO guardians.userId lookup and NO
//     "primary guardian" resolution; the invoice/registration bill the caller.
//   • IDOR BOUNDARY: verify a travel_guardian_athletes row links
//     (guardianId, athleteId). Absent → athlete_not_owned. A guardian can never
//     register an athlete they don't own.
//   • AUTO-ROSTER (NOT in Northstar): when product.teamId is set, the athlete is
//     idempotently added to travel_team_athletes (onConflictDoNothing guards the
//     composite PK — matches the Block-2 Accept pattern in applications.ts).
//   • NO forms (formData stays null), NO discounts (empty adjustments), NO
//     payment plan (Block 4). NO deposit/installment.
//
// MONEY SAFETY: the invoice total/lines come from the SAME pure pricing engine
// (computeInvoiceLines) and are asserted to sum before the write; everything
// commits in ONE db.batch — the neon-http driver has NO interactive txn, so ids
// are pre-generated with crypto.randomUUID() (batch can't thread RETURNING).

import { and, asc, eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { db } from "@/db";
import {
  travelAthletes,
  travelEnrollments,
  travelGuardianAthletes,
  travelGuardians,
  travelInvoiceLines,
  travelInvoices,
  travelProducts,
  travelRegistrations,
  travelTeamAthletes,
} from "@/db/schema";
import type { TravelProductPriceTier } from "@/db/schema";
import { computeInvoiceLines, resolveTierPrice } from "@/travel/pricing";

// The product types a guardian can self-register a kid INTO. Deliberately a
// small allowlist (defense in depth) so a crafted request can never enroll a
// kid into a uniform/membership/tournament/other product.
export const REGISTERABLE_TRAVEL_PRODUCT_TYPES = [
  "travel",
  "program",
  "camp",
  "clinic",
] as const;

// ---------------------------------------------------------------------------
// Reads for the registration form (used by Blocks 3c/3d).
// ---------------------------------------------------------------------------

export type RegisterableTravelProduct = {
  id: string;
  name: string;
  type: string;
  basePriceCents: number | null;
  /**
   * Selectable price tiers. Null/empty = a flat single-price product (uses
   * basePriceCents). Sent to the form so the parent picks a tier; the chosen
   * tier's price is RE-RESOLVED server-side by key at registration (the client
   * never sends a price).
   */
  priceTiers: TravelProductPriceTier[] | null;
  description: string | null;
  teamId: string | null;
};

/**
 * Active, registerable products for the public catalog (cheapest first, then by
 * name). No guardian scoping — this is a public read. A product is included when
 * it is active, its type is registerable, and it has a price source (a non-null
 * basePriceCents OR a non-empty priceTiers).
 */
export async function listRegisterableTravelProducts(): Promise<
  RegisterableTravelProduct[]
> {
  const rows = await db
    .select({
      id: travelProducts.id,
      name: travelProducts.name,
      type: travelProducts.type,
      basePriceCents: travelProducts.basePriceCents,
      priceTiers: travelProducts.priceTiers,
      description: travelProducts.description,
      teamId: travelProducts.teamId,
      active: travelProducts.active,
    })
    .from(travelProducts)
    .where(eq(travelProducts.active, true));

  return rows
    .filter(
      (r) =>
        (REGISTERABLE_TRAVEL_PRODUCT_TYPES as readonly string[]).includes(
          r.type,
        ) &&
        (r.basePriceCents !== null || (r.priceTiers ?? []).length > 0),
    )
    .map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      basePriceCents: r.basePriceCents,
      priceTiers: r.priceTiers ?? null,
      description: r.description,
      teamId: r.teamId,
    }))
    .sort((a, b) => {
      const pa = a.basePriceCents ?? (a.priceTiers?.[0]?.priceCents ?? 0);
      const pb = b.basePriceCents ?? (b.priceTiers?.[0]?.priceCents ?? 0);
      return pa - pb || a.name.localeCompare(b.name);
    });
}

export type RegisterableAthlete = {
  id: string;
  firstName: string;
  lastName: string;
};

/**
 * The caller-guardian's OWN athletes (via travel_guardian_athletes), sorted by
 * lastName then firstName. IDOR-scoped: only athletes linked to params
 * guardianId are returned.
 */
export async function listRegisterableAthletesForGuardian(
  guardianId: string,
): Promise<RegisterableAthlete[]> {
  return db
    .select({
      id: travelAthletes.id,
      firstName: travelAthletes.firstName,
      lastName: travelAthletes.lastName,
    })
    .from(travelGuardianAthletes)
    .innerJoin(
      travelAthletes,
      eq(travelAthletes.id, travelGuardianAthletes.athleteId),
    )
    .where(eq(travelGuardianAthletes.guardianId, guardianId))
    .orderBy(asc(travelAthletes.lastName), asc(travelAthletes.firstName));
}

// ---------------------------------------------------------------------------
// Register: registration + enrollment + invoice (+ auto-roster), one batch.
// ---------------------------------------------------------------------------

export type RegisterResult =
  | { ok: true; invoiceId: string; totalCents: number }
  | {
      ok: false;
      error:
        | "no_guardian"
        | "athlete_not_owned"
        | "product_unavailable"
        | "tier_required"
        | "already_enrolled";
    };

/**
 * Register one of the CALLER-GUARDIAN's OWN athletes for an active, priced,
 * registerable product: writes registration (consumer) + enrollment + invoice
 * (+ lines) atomically, billed to params.guardianId, AND auto-rosters the
 * athlete onto the product's team (if any). Returns the invoice id so the caller
 * can route to checkout later. IDOR-safe; rejects an unowned athlete, an
 * inactive/unpriced/non-registerable product, a missing/invalid tier, or a
 * duplicate enrollment.
 */
export async function registerTravelAthleteForProduct(params: {
  guardianId: string;
  athleteId: string;
  productId: string;
  /**
   * The chosen price tier KEY (when the product has tiers). NEVER a price — the
   * server re-resolves the priceCents from the product's own config by this key
   * (the money-correctness boundary). Ignored for flat products.
   */
  tierKey?: string | null;
}): Promise<RegisterResult> {
  // The caller IS the guardian (session-native). Confirm the guardian exists —
  // a stale session / bad id is rejected before anything is written.
  const [guardian] = await db
    .select({ id: travelGuardians.id })
    .from(travelGuardians)
    .where(eq(travelGuardians.id, params.guardianId))
    .limit(1);
  if (!guardian) return { ok: false, error: "no_guardian" };

  // IDOR: the athlete must be linked to the CALLER's guardian row. No facility
  // `users` lookup — the guardian is the session subject directly.
  const [link] = await db
    .select({ athleteId: travelGuardianAthletes.athleteId })
    .from(travelGuardianAthletes)
    .where(
      and(
        eq(travelGuardianAthletes.guardianId, params.guardianId),
        eq(travelGuardianAthletes.athleteId, params.athleteId),
      ),
    )
    .limit(1);
  if (!link) return { ok: false, error: "athlete_not_owned" };

  // Product must be active + have a price source + a REGISTERABLE type (defense
  // in depth: a crafted request can't enroll a kid into a uniform/POS/membership).
  const [product] = await db
    .select({
      id: travelProducts.id,
      name: travelProducts.name,
      type: travelProducts.type,
      basePriceCents: travelProducts.basePriceCents,
      priceTiers: travelProducts.priceTiers,
      teamId: travelProducts.teamId,
      active: travelProducts.active,
    })
    .from(travelProducts)
    .where(eq(travelProducts.id, params.productId))
    .limit(1);
  const hasPriceSource =
    !!product &&
    (product.basePriceCents !== null ||
      (product.priceTiers ?? []).length > 0);
  if (
    !product ||
    !product.active ||
    !hasPriceSource ||
    !(REGISTERABLE_TRAVEL_PRODUCT_TYPES as readonly string[]).includes(
      product.type,
    )
  ) {
    return { ok: false, error: "product_unavailable" };
  }

  // PRICE TIER (money-correctness crux): a tiered product bills the tier's
  // server-resolved priceCents by KEY (never a client-supplied amount); a
  // missing/invalid key is rejected (never a silent fall back). A flat product
  // (no tiers) bills basePriceCents and the line keeps the base name.
  const hasTiers = (product.priceTiers ?? []).length > 0;
  let lineBasePriceCents: number;
  let lineDescription = product.name;
  if (hasTiers) {
    const resolved = resolveTierPrice(product.priceTiers, params.tierKey);
    if (!resolved.ok) {
      // Missing/blank OR an unknown key → tier_required (never silently fall
      // back to a base price the parent didn't pick). tier_not_found is folded
      // into the same caller-facing code.
      return { ok: false, error: "tier_required" };
    }
    lineBasePriceCents = resolved.tier.priceCents;
    // Carry the bought tier into the line description so parent + admin see it.
    lineDescription = `${product.name} — ${resolved.tier.label}`;
  } else {
    // Flat product: hasPriceSource guaranteed basePriceCents is non-null here.
    lineBasePriceCents = product.basePriceCents as number;
  }

  // One enrollment per (athlete, product) — reject a duplicate up front (the
  // unique index travel_enrollments_athlete_product_unique is the backstop).
  const [existing] = await db
    .select({ id: travelEnrollments.id })
    .from(travelEnrollments)
    .where(
      and(
        eq(travelEnrollments.athleteId, params.athleteId),
        eq(travelEnrollments.productId, params.productId),
      ),
    )
    .limit(1);
  if (existing) return { ok: false, error: "already_enrolled" };

  // Price via the SAME pure engine the admin builder uses (no adjustments in v1
  // — sibling/aid discounts can be layered in later).
  const { lines, totalCents } = computeInvoiceLines({
    basePriceCents: lineBasePriceCents,
    baseDescription: lineDescription,
    adjustments: [],
  });
  const linesSum = lines.reduce((n, l) => n + l.amountCents, 0);
  if (linesSum !== totalCents) {
    throw new Error(
      `registerTravelAthleteForProduct: lines ${linesSum} != total ${totalCents}`,
    );
  }

  // Pre-generate ids (neon-http batch can't thread RETURNING ids).
  const registrationId = crypto.randomUUID();
  const enrollmentId = crypto.randomUUID();
  const invoiceId = crypto.randomUUID();

  const statements: BatchItem<"pg">[] = [
    db.insert(travelRegistrations).values({
      id: registrationId,
      productId: product.id,
      athleteId: params.athleteId,
      guardianId: params.guardianId,
      status: "active",
      source: "consumer",
      formData: null, // NO forms in v1.
    }),
    db.insert(travelEnrollments).values({
      id: enrollmentId,
      athleteId: params.athleteId,
      productId: product.id,
      registrationId,
      status: "active",
    }),
    db.insert(travelInvoices).values({
      id: invoiceId,
      guardianId: params.guardianId,
      athleteId: params.athleteId,
      productId: product.id,
      totalCents,
      balanceCents: totalCents, // fresh invoice — nothing paid
      status: "pending",
      purchaseSource: "consumer",
    }),
    db.insert(travelInvoiceLines).values(
      lines.map((l) => ({
        id: crypto.randomUUID(),
        invoiceId,
        description: l.description,
        amountCents: l.amountCents,
        productId: product.id,
      })),
    ),
  ];

  // AUTO-ROSTER (the Block-3 addition — NOT in Northstar): if the product ties
  // to a team, idempotently add the athlete to that team's roster.
  // onConflictDoNothing guards the composite PK so a re-add is harmless (matches
  // the Block-2 Accept pattern in applications.ts).
  if (product.teamId) {
    statements.push(
      db
        .insert(travelTeamAthletes)
        .values({ teamId: product.teamId, athleteId: params.athleteId, status: "active" })
        .onConflictDoNothing(),
    );
  }

  try {
    await db.batch(
      statements as [(typeof statements)[number], ...typeof statements],
    );
  } catch (err) {
    // CONCURRENCY: the already_enrolled pre-check is a fast path, not a lock —
    // two simultaneous submits can both pass it and race to insert the
    // enrollment. The unique index travel_enrollments_athlete_product_unique is
    // the backstop: the loser's batch fails with a Postgres unique violation
    // (SQLSTATE 23505). Resolve that race to the SAME friendly shape as the
    // pre-check. Narrow: re-throw anything that isn't a unique violation so real
    // errors still surface.
    if (isUniqueViolation(err)) {
      return { ok: false, error: "already_enrolled" };
    }
    throw err;
  }

  return { ok: true, invoiceId, totalCents };
}

/**
 * True when an error is a Postgres unique-constraint violation (SQLSTATE
 * 23505). neon-http surfaces the driver error with a `code` field; we also fall
 * back to matching the message text so a wrapped error is still caught.
 * Deliberately narrow — only the enrollment dedup race should be converted.
 */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === "23505") return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" && /23505|unique constraint/i.test(message);
}
