"use server";

import { redirect, unstable_rethrow } from "next/navigation";
import * as Sentry from "@sentry/nextjs";
import { requireTravelAccess } from "@/travel/authz";
import { createTravelProduct, type ProductInput } from "@/travel/catalog";
import type { TravelProductPriceTier } from "@/db/schema";

// Block 3d-1 — the CREATE product server action. Re-checks requireTravelAccess()
// (its own entry point). Parses the form, converts the operator's DOLLAR strings
// to integer CENTS (the money-correctness boundary — the client never sends
// cents), calls createTravelProduct, maps {ok:false} → ?error=<code>, and on
// success routes to the catalog with ?saved=1.

// Trim → null if blank.
function optional(value: FormDataEntryValue | null): string | null {
  const s = value?.toString().trim();
  return s ? s : null;
}

// Parse a DOLLAR string ("1500", "1500.00", "$1,500.00") → non-negative integer
// CENTS, or null if it isn't a valid non-negative money amount. Strips $ and
// thousands separators; rejects anything non-numeric or negative. Rounds to the
// nearest cent (Math.round) so floating dollars can't leak a fractional cent.
function dollarsToCents(raw: string | null): number | null {
  if (raw === null) return null;
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (cleaned === "") return null;
  const dollars = Number(cleaned);
  if (!Number.isFinite(dollars) || dollars < 0) return null;
  return Math.round(dollars * 100);
}

// Assemble the price-source half of ProductInput from the raw form. Returns a
// discriminated "bad" marker (→ price_required) rather than throwing, so the
// action can banner it uniformly with the data-layer's own price_required.
function parsePrice(
  formData: FormData,
):
  | { mode: "flat"; basePriceCents: number }
  | { mode: "tiered"; priceTiers: TravelProductPriceTier[] }
  | { bad: true } {
  const priceMode = formData.get("priceMode")?.toString();

  if (priceMode === "flat") {
    const cents = dollarsToCents(formData.get("basePriceDollars")?.toString() ?? null);
    if (cents === null) return { bad: true };
    return { mode: "flat", basePriceCents: cents };
  }

  if (priceMode === "tiered") {
    // The tier rows submit three parallel arrays; zip them by index.
    const keys = formData.getAll("tierKey").map((v) => v.toString());
    const labels = formData.getAll("tierLabel").map((v) => v.toString());
    const prices = formData.getAll("tierPrice").map((v) => v.toString());

    const tiers: TravelProductPriceTier[] = [];
    for (let i = 0; i < keys.length; i++) {
      const key = (keys[i] ?? "").trim();
      const label = (labels[i] ?? "").trim();
      const priceRaw = prices[i] ?? "";
      // Skip a fully-blank trailing row; a partially-filled row falls through to
      // validation in the data layer (missing key/label/price → price_required).
      if (!key && !label && priceRaw.trim() === "") continue;
      const cents = dollarsToCents(priceRaw);
      if (cents === null) return { bad: true };
      tiers.push({ key, label, priceCents: cents });
    }
    if (tiers.length === 0) return { bad: true };
    return { mode: "tiered", priceTiers: tiers };
  }

  return { bad: true };
}

export async function createProductAction(formData: FormData): Promise<void> {
  await requireTravelAccess();

  const price = parsePrice(formData);
  if ("bad" in price) {
    redirect("/travel/admin/products/new?error=price_required");
  }

  const input: ProductInput = {
    name: formData.get("name")?.toString() ?? "",
    type: formData.get("type")?.toString() ?? "",
    seasonId: optional(formData.get("seasonId")),
    locationId: optional(formData.get("locationId")),
    teamId: optional(formData.get("teamId")),
    description: optional(formData.get("description")),
    priceMode: price.mode,
    basePriceCents: price.mode === "flat" ? price.basePriceCents : undefined,
    priceTiers: price.mode === "tiered" ? price.priceTiers : undefined,
    // Optional deposit amount (dollars → cents; blank/invalid → null).
    depositCents: dollarsToCents(
      formData.get("depositDollars")?.toString() ?? null,
    ),
    // Optional monthly installment amount (dollars → cents; blank/invalid → null).
    monthlyInstallmentCents: dollarsToCents(
      formData.get("monthlyAmountDollars")?.toString() ?? null,
    ),
    // Unchecked checkbox → absent from FormData → inactive.
    active: formData.get("active")?.toString() === "on",
  };

  let result: Awaited<ReturnType<typeof createTravelProduct>>;
  try {
    result = await createTravelProduct(input);
  } catch (err) {
    // The redirect above throws NEXT_REDIRECT — let framework errors propagate.
    unstable_rethrow(err);
    Sentry.captureException(err, {
      tags: { area: "travel-product-create" },
      extra: { name: input.name, type: input.type },
    });
    redirect("/travel/admin/products/new?error=1");
  }

  if (!result.ok) {
    redirect(`/travel/admin/products/new?error=${result.error}`);
  }

  redirect("/travel/admin/products?saved=1");
}
