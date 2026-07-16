"use server";

import { redirect, unstable_rethrow } from "next/navigation";
import * as Sentry from "@sentry/nextjs";
import { requireTravelAccess } from "@/travel/authz";
import { updateTravelProduct, type ProductInput } from "@/travel/catalog";
import type { TravelProductPriceTier } from "@/db/schema";

// Block 3d-1 — the UPDATE product server action. Mirrors new/actions.ts: its own
// requireTravelAccess() check, DOLLAR→CENTS conversion server-side (client never
// sends cents), {ok:false} → ?error=<code> on the edit URL, success → catalog
// ?saved=1. The product id rides in a hidden field.

function optional(value: FormDataEntryValue | null): string | null {
  const s = value?.toString().trim();
  return s ? s : null;
}

// Parse a DOLLAR string → non-negative integer CENTS, or null if invalid.
function dollarsToCents(raw: string | null): number | null {
  if (raw === null) return null;
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (cleaned === "") return null;
  const dollars = Number(cleaned);
  if (!Number.isFinite(dollars) || dollars < 0) return null;
  return Math.round(dollars * 100);
}

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
    const keys = formData.getAll("tierKey").map((v) => v.toString());
    const labels = formData.getAll("tierLabel").map((v) => v.toString());
    const prices = formData.getAll("tierPrice").map((v) => v.toString());

    const tiers: TravelProductPriceTier[] = [];
    for (let i = 0; i < keys.length; i++) {
      const key = (keys[i] ?? "").trim();
      const label = (labels[i] ?? "").trim();
      const priceRaw = prices[i] ?? "";
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

export async function updateProductAction(formData: FormData): Promise<void> {
  await requireTravelAccess();

  const id = formData.get("id")?.toString().trim();
  if (!id) redirect("/travel/admin/products?error=not_found");

  const price = parsePrice(formData);
  if ("bad" in price) {
    redirect(`/travel/admin/products/${id}/edit?error=price_required`);
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
    active: formData.get("active")?.toString() === "on",
  };

  let result: Awaited<ReturnType<typeof updateTravelProduct>>;
  try {
    result = await updateTravelProduct(id, input);
  } catch (err) {
    // The redirects above throw NEXT_REDIRECT — let framework errors propagate.
    unstable_rethrow(err);
    Sentry.captureException(err, {
      tags: { area: "travel-product-update" },
      extra: { id, name: input.name, type: input.type },
    });
    redirect(`/travel/admin/products/${id}/edit?error=1`);
  }

  if (!result.ok) {
    redirect(`/travel/admin/products/${id}/edit?error=${result.error}`);
  }

  redirect("/travel/admin/products?saved=1");
}
