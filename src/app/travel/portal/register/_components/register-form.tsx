"use client";

import { useState } from "react";
import type { RegisterableTravelProduct } from "@/travel/registration";
import { submitRegistration } from "../actions";

// Block 3c — the controlled registration form. A guardian picks one of their
// OWN athletes and a registerable program, then (only for a tiered program) an
// option (tier). We submit ids + an optional tierKey — NEVER a price; the engine
// re-resolves the tier's amount server-side.
//
// Skin: matches the travel apply form — credential (tracked-uppercase) labels,
// sharp rounded-md, flat (no shadow), hairline border, gold focus ring + gold
// primary button. Facility tokens only.

type Athlete = { id: string; firstName: string; lastName: string };

// Shared field-label class: credential style (tracked uppercase micro-label).
const LABEL =
  "block text-[11px] uppercase tracking-wider font-semibold text-fg-muted";
// Shared input class: sharp, flat, hairline border, gold focus ring.
const INPUT =
  "w-full rounded-md border border-line bg-page h-10 px-3 text-sm text-fg placeholder:text-fg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40";

// Format cents → "$1,234.00" for DISPLAY only. No price is ever submitted.
function formatUsd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

// Cheapest tier price for a tiered product (tiers are non-empty when called).
function cheapestTierCents(tiers: RegisterableTravelProduct["priceTiers"]): number {
  return (tiers ?? []).reduce(
    (min, t) => (t.priceCents < min ? t.priceCents : min),
    Number.POSITIVE_INFINITY,
  );
}

// The option label: "Name — $price" for a flat product, "Name — from $x" tiered.
function productLabel(p: RegisterableTravelProduct): string {
  const tiers = p.priceTiers ?? [];
  if (tiers.length > 0) {
    return `${p.name} — from ${formatUsd(cheapestTierCents(tiers))}`;
  }
  if (p.basePriceCents !== null) {
    return `${p.name} — ${formatUsd(p.basePriceCents)}`;
  }
  return p.name;
}

export function RegisterForm({
  athletes,
  products,
}: {
  athletes: Athlete[];
  products: RegisterableTravelProduct[];
}) {
  const [athleteId, setAthleteId] = useState("");
  const [productId, setProductId] = useState("");
  // The chosen tier KEY (submits as tierKey). Reset whenever the product changes.
  const [tierKey, setTierKey] = useState("");

  const selectedProduct = products.find((p) => p.id === productId) ?? null;
  const tiers = selectedProduct?.priceTiers ?? [];
  const hasTiers = tiers.length > 0;

  function onProductChange(nextProductId: string) {
    setProductId(nextProductId);
    // Selecting a different program resets any prior tier choice.
    setTierKey("");
  }

  return (
    <form action={submitRegistration} className="space-y-5">
      {/* Player */}
      <div className="space-y-1.5">
        <label htmlFor="athleteId" className={LABEL}>
          Player
        </label>
        <select
          id="athleteId"
          name="athleteId"
          required
          value={athleteId}
          onChange={(e) => setAthleteId(e.target.value)}
          className={INPUT}
        >
          <option value="">Select a player…</option>
          {athletes.map((a) => (
            <option key={a.id} value={a.id}>
              {a.firstName} {a.lastName}
            </option>
          ))}
        </select>
      </div>

      {/* Program */}
      <div className="space-y-1.5 border-t border-line pt-4">
        <label htmlFor="productId" className={LABEL}>
          Program
        </label>
        <select
          id="productId"
          name="productId"
          required
          value={productId}
          disabled={products.length === 0}
          onChange={(e) => onProductChange(e.target.value)}
          className={`${INPUT} disabled:opacity-60`}
        >
          <option value="">Select a program…</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {productLabel(p)}
            </option>
          ))}
        </select>
        {products.length === 0 ? (
          <p className="text-xs text-fg-subtle">
            No programs are open for registration right now.
          </p>
        ) : selectedProduct?.description ? (
          <p className="text-xs text-fg-muted">{selectedProduct.description}</p>
        ) : null}
      </div>

      {/* Options (tiers) — revealed ONLY for a tiered program. The chosen tier's
          key submits as `tierKey`; the engine re-resolves its price. */}
      {hasTiers ? (
        <fieldset className="space-y-3 border-t border-line pt-4">
          <legend className="text-[11px] uppercase tracking-wider font-semibold text-fg-subtle">
            Option
          </legend>
          <div className="space-y-2">
            {tiers.map((t) => (
              <label
                key={t.key}
                className="flex cursor-pointer items-center justify-between gap-4 rounded-md border border-line bg-page px-3 py-2.5 has-[:checked]:border-l-2 has-[:checked]:border-l-yellow"
              >
                <span className="flex items-center gap-3">
                  <input
                    type="radio"
                    name="tierKey"
                    value={t.key}
                    required
                    checked={tierKey === t.key}
                    onChange={(e) => setTierKey(e.target.value)}
                    className="size-4 accent-yellow"
                  />
                  <span className="text-sm font-medium text-fg">{t.label}</span>
                </span>
                <span className="text-sm font-semibold text-fg-muted">
                  {formatUsd(t.priceCents)}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}

      <button
        type="submit"
        className="w-full rounded-md bg-yellow text-gold-ink h-10 px-4 text-sm font-semibold transition-colors hover:bg-gold-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40"
      >
        Register player
      </button>
    </form>
  );
}
