"use client";

import { useState } from "react";
import type { TravelProductPriceTier } from "@/db/schema";

// Block 3d-1 — the shared operator create/edit product form. Controlled so the
// price-mode toggle can show only the active mode's fields; ONLY the active
// mode's inputs carry a submittable `name`, so the server action never receives
// both a flat price and tiers.
//
// MONEY: the operator types DOLLARS (string like "1500.00"). This form NEVER
// computes or submits cents — it submits the raw dollar strings; the server
// action parses + rounds to integer cents (the money-correctness boundary). A
// stale hidden cents value can't be trusted, so none exists.
//
// Skin: elevated travel — credential (tracked-uppercase) micro-labels, sharp
// rounded-md, flat (no shadow), hairline border on bg-page, gold focus ring +
// gold primary button. Facility tokens only.

type Option = { id: string; name: string };

// Shared field classes (mirrors the apply / register forms).
const LABEL =
  "block text-[11px] uppercase tracking-wider font-semibold text-fg-muted";
const INPUT =
  "w-full rounded-md border border-line bg-page h-10 px-3 text-sm text-fg placeholder:text-fg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40";

// A tier row in the editor. `cents` is null when the product being edited is
// tiered; we render it back as a dollar string for the input.
type TierRow = { key: string; label: string; price: string };

function centsToDollarString(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  return (cents / 100).toFixed(2);
}

export function ProductForm({
  mode,
  action,
  productId,
  productTypes,
  registerableTypes,
  seasons,
  locations,
  teams,
  initial,
  errorMessage,
}: {
  mode: "create" | "edit";
  // The server action (createProductAction / updateProductAction).
  action: (formData: FormData) => void | Promise<void>;
  // The row id to edit — emitted as a hidden field INSIDE this form so the
  // update action can target it. Absent on create.
  productId?: string;
  productTypes: readonly string[];
  // Types a parent can self-register into — shown as a hint on the select.
  registerableTypes: string[];
  seasons: Option[];
  locations: Option[];
  teams: Option[];
  initial?: {
    name: string;
    type: string;
    seasonId: string | null;
    locationId: string | null;
    teamId: string | null;
    description: string | null;
    basePriceCents: number | null;
    priceTiers: TravelProductPriceTier[] | null;
    active: boolean;
  };
  errorMessage?: string | null;
}) {
  const initialTiered = !!initial && (initial.priceTiers?.length ?? 0) > 0;

  const [priceMode, setPriceMode] = useState<"flat" | "tiered">(
    initialTiered ? "tiered" : "flat",
  );
  const [flatPrice, setFlatPrice] = useState<string>(
    initial && !initialTiered
      ? centsToDollarString(initial.basePriceCents)
      : "",
  );
  const [tiers, setTiers] = useState<TierRow[]>(
    initialTiered
      ? (initial!.priceTiers ?? []).map((t) => ({
          key: t.key,
          label: t.label,
          price: centsToDollarString(t.priceCents),
        }))
      : [{ key: "", label: "", price: "" }],
  );

  const registerableSet = new Set(registerableTypes);

  function updateTier(i: number, patch: Partial<TierRow>) {
    setTiers((prev) =>
      prev.map((row, idx) => (idx === i ? { ...row, ...patch } : row)),
    );
  }
  function addTier() {
    setTiers((prev) => [...prev, { key: "", label: "", price: "" }]);
  }
  function removeTier(i: number) {
    setTiers((prev) =>
      prev.length <= 1 ? prev : prev.filter((_, idx) => idx !== i),
    );
  }

  return (
    <form action={action} className="space-y-6">
      {errorMessage ? (
        <p
          role="alert"
          className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          {errorMessage}
        </p>
      ) : null}

      {/* The row id (edit only) — the update action targets this. */}
      {productId ? <input type="hidden" name="id" value={productId} /> : null}

      {/* The price mode is submitted so the action knows which fields to read. */}
      <input type="hidden" name="priceMode" value={priceMode} />

      {/* Name */}
      <div className="space-y-1.5">
        <label htmlFor="name" className={LABEL}>
          Product name
        </label>
        <input
          id="name"
          name="name"
          required
          defaultValue={initial?.name ?? ""}
          placeholder="2026 Spring Season Dues"
          className={INPUT}
        />
      </div>

      {/* Type */}
      <div className="space-y-1.5">
        <label htmlFor="type" className={LABEL}>
          Type
        </label>
        <select
          id="type"
          name="type"
          required
          defaultValue={initial?.type ?? productTypes[0]}
          className={INPUT}
        >
          {productTypes.map((t) => (
            <option key={t} value={t}>
              {t}
              {registerableSet.has(t) ? " (registerable)" : ""}
            </option>
          ))}
        </select>
        <p className="text-xs text-fg-subtle">
          Registerable types are the ones parents can sign a player up for.
        </p>
      </div>

      {/* Season / Location / Team (all optional) */}
      <div className="grid grid-cols-1 gap-4 border-t border-line pt-4 sm:grid-cols-3">
        <div className="space-y-1.5">
          <label htmlFor="seasonId" className={LABEL}>
            Season
          </label>
          <select
            id="seasonId"
            name="seasonId"
            defaultValue={initial?.seasonId ?? ""}
            className={INPUT}
          >
            <option value="">— none —</option>
            {seasons.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="locationId" className={LABEL}>
            Location
          </label>
          <select
            id="locationId"
            name="locationId"
            defaultValue={initial?.locationId ?? ""}
            className={INPUT}
          >
            <option value="">— none —</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="teamId" className={LABEL}>
            Team (auto-roster)
          </label>
          <select
            id="teamId"
            name="teamId"
            defaultValue={initial?.teamId ?? ""}
            className={INPUT}
          >
            <option value="">— none —</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Description */}
      <div className="space-y-1.5">
        <label htmlFor="description" className={LABEL}>
          Description (optional)
        </label>
        <textarea
          id="description"
          name="description"
          rows={3}
          defaultValue={initial?.description ?? ""}
          placeholder="What this product covers…"
          className={`${INPUT} h-auto py-2`}
        />
      </div>

      {/* Price mode toggle */}
      <fieldset className="space-y-3 border-t border-line pt-4">
        <legend className="text-[11px] uppercase tracking-wider font-semibold text-fg-subtle">
          Price
        </legend>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setPriceMode("flat")}
            className={`rounded-md border px-4 h-9 inline-flex items-center text-sm font-semibold transition-colors ${
              priceMode === "flat"
                ? "border-yellow/40 bg-yellow/10 text-gold"
                : "border-line bg-surface text-fg-muted hover:text-fg hover:border-line-strong"
            }`}
          >
            Flat price
          </button>
          <button
            type="button"
            onClick={() => setPriceMode("tiered")}
            className={`rounded-md border px-4 h-9 inline-flex items-center text-sm font-semibold transition-colors ${
              priceMode === "tiered"
                ? "border-yellow/40 bg-yellow/10 text-gold"
                : "border-line bg-surface text-fg-muted hover:text-fg hover:border-line-strong"
            }`}
          >
            Tiered
          </button>
        </div>

        {/* FLAT — only rendered (and only carries a submittable name) when active. */}
        {priceMode === "flat" ? (
          <div className="space-y-1.5">
            <label htmlFor="basePriceDollars" className={LABEL}>
              Price (USD)
            </label>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-fg-subtle">
                $
              </span>
              <input
                id="basePriceDollars"
                name="basePriceDollars"
                inputMode="decimal"
                required
                value={flatPrice}
                onChange={(e) => setFlatPrice(e.target.value)}
                placeholder="1500.00"
                className={`${INPUT} pl-7`}
              />
            </div>
          </div>
        ) : (
          /* TIERED — a repeatable row editor. Each row submits three parallel
             arrays (tierKey / tierLabel / tierPrice); the action zips them by
             index. Add/remove rows client-side. */
          <div className="space-y-3">
            {tiers.map((row, i) => (
              <div
                key={i}
                className="grid grid-cols-1 gap-2 rounded-md border border-line bg-page p-3 sm:grid-cols-[1fr_1fr_1fr_auto]"
              >
                <div className="space-y-1">
                  <label className={LABEL}>Key</label>
                  <input
                    name="tierKey"
                    value={row.key}
                    onChange={(e) => updateTier(i, { key: e.target.value })}
                    placeholder="full"
                    className={INPUT}
                  />
                </div>
                <div className="space-y-1">
                  <label className={LABEL}>Label</label>
                  <input
                    name="tierLabel"
                    value={row.label}
                    onChange={(e) => updateTier(i, { label: e.target.value })}
                    placeholder="Full season"
                    className={INPUT}
                  />
                </div>
                <div className="space-y-1">
                  <label className={LABEL}>Price (USD)</label>
                  <div className="relative">
                    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-fg-subtle">
                      $
                    </span>
                    <input
                      name="tierPrice"
                      inputMode="decimal"
                      value={row.price}
                      onChange={(e) => updateTier(i, { price: e.target.value })}
                      placeholder="1500.00"
                      className={`${INPUT} pl-7`}
                    />
                  </div>
                </div>
                <div className="flex items-end">
                  <button
                    type="button"
                    onClick={() => removeTier(i)}
                    disabled={tiers.length <= 1}
                    className="rounded-md border border-line bg-surface-2 h-10 px-3 text-sm font-semibold text-fg-muted transition-colors hover:text-fg hover:border-line-strong disabled:opacity-40 disabled:hover:text-fg-muted disabled:hover:border-line"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
            <button
              type="button"
              onClick={addTier}
              className="rounded-md border border-line bg-surface h-9 px-4 text-sm font-semibold text-fg-muted transition-colors hover:text-fg hover:border-line-strong"
            >
              + Add tier
            </button>
          </div>
        )}
      </fieldset>

      {/* Active */}
      <div className="flex items-center gap-2 border-t border-line pt-4">
        <input
          id="active"
          name="active"
          type="checkbox"
          defaultChecked={initial ? initial.active : true}
          className="size-4 accent-yellow"
        />
        <label htmlFor="active" className="text-sm font-medium text-fg">
          Active (available in the catalog / for registration)
        </label>
      </div>

      <div className="flex gap-3 border-t border-line pt-4">
        <button
          type="submit"
          className="rounded-md bg-yellow text-gold-ink h-10 px-5 text-sm font-semibold transition-colors hover:bg-gold-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40"
        >
          {mode === "create" ? "Create product" : "Save changes"}
        </button>
      </div>
    </form>
  );
}
