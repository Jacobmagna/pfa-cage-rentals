"use client";

// QA2 #6 — how this coach's FUTURE logged work is paid: "Hourly" (the
// default, the existing per-30-min rate snapshot) vs "Per session" (a
// flat per-session amount). The dollar input is only relevant — and only
// required — when Per session is selected. Single save form
// (useActionState), mirroring handles-card.tsx.
//
// IMPORTANT (surfaced in the UI copy): this sets the basis for work logged
// AFTER the change. It does NOT retroactively re-rate already-logged work
// — the billing layer snapshots the basis at log time.

import { useActionState, useState } from "react";
import { Check } from "lucide-react";
import {
  updateCoachPayModeFormAction,
  type PayModeActionResult,
} from "../coach-settings-form-actions";
import type { CoachPayMode } from "@/db/schema";

const INITIAL_STATE: PayModeActionResult = { ok: true };

export function CoachPayModeCard({
  coachId,
  initialPayMode,
  initialPerSessionRateCents,
}: {
  coachId: string;
  initialPayMode: CoachPayMode;
  initialPerSessionRateCents: number | null;
}) {
  const [state, action, pending] = useActionState(
    updateCoachPayModeFormAction,
    INITIAL_STATE,
  );

  const initialDollars =
    initialPerSessionRateCents != null
      ? (initialPerSessionRateCents / 100).toFixed(2)
      : "";

  // Controlled radio so the dollar input shows/hides live as the admin
  // toggles. Seed from the echoed-back value on error, else the stored
  // setting.
  const seededMode: CoachPayMode = !state.ok
    ? state.values.payMode
    : initialPayMode;
  const seededDollars = !state.ok ? state.values.perSessionDollars : initialDollars;
  const [mode, setMode] = useState<CoachPayMode>(seededMode);

  // Re-key on a successful save so the controlled state re-seeds from the
  // revalidated props.
  const formKey = state.ok
    ? `ok-${initialPayMode}-${initialPerSessionRateCents ?? "none"}`
    : `err-${state.error.code}-${state.error.message}`;

  return (
    <section
      key={formKey}
      className="my-8 rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)] overflow-hidden"
    >
      <header className="px-5 py-4 border-b border-line">
        <h3 className="text-base font-semibold text-fg">Work pay mode</h3>
        <p className="mt-1 text-xs text-fg-muted leading-relaxed">
          How this coach is paid for logged work. Applies to{" "}
          <span className="text-fg">future logged work only</span> — already
          logged work keeps the basis it was stamped with and is not
          re-rated.
        </p>
      </header>

      <form action={action} className="space-y-4 p-5">
        <input type="hidden" name="coachId" defaultValue={coachId} />

        {!state.ok ? (
          <div
            role="alert"
            className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
          >
            {state.error.message}
          </div>
        ) : null}

        <fieldset className="space-y-2">
          <legend className="text-xs uppercase tracking-wider text-fg-muted mb-1.5">
            Pay mode
          </legend>

          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="radio"
              name="payMode"
              value="hourly"
              checked={mode === "hourly"}
              onChange={() => setMode("hourly")}
              className="mt-0.5 h-4 w-4 accent-gold"
            />
            <span>
              <span className="block text-sm font-medium text-fg">Hourly</span>
              <span className="block text-[11px] text-fg-subtle leading-snug">
                Pay by the per-30-min work rate on each logged session
                (default).
              </span>
            </span>
          </label>

          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="radio"
              name="payMode"
              value="per_session"
              checked={mode === "per_session"}
              onChange={() => setMode("per_session")}
              className="mt-0.5 h-4 w-4 accent-gold"
            />
            <span>
              <span className="block text-sm font-medium text-fg">
                Per session
              </span>
              <span className="block text-[11px] text-fg-subtle leading-snug">
                Pay a flat amount per logged session, regardless of length.
              </span>
            </span>
          </label>
        </fieldset>

        {mode === "per_session" ? (
          <label className="block">
            <span className="text-xs uppercase tracking-wider text-fg-muted mb-1.5 block">
              Per-session amount
            </span>
            <div className="relative max-w-[200px]">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle text-sm">
                $
              </span>
              <input
                type="text"
                inputMode="decimal"
                name="perSessionDollars"
                defaultValue={seededDollars}
                placeholder="0.00"
                aria-label="Per-session amount in dollars"
                className="w-full pl-7 pr-3 h-10 rounded-lg bg-surface border border-line text-fg placeholder:text-fg-subtle text-sm focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40"
              />
            </div>
            <span className="block text-[11px] text-fg-subtle mt-1 leading-snug">
              Flat dollars paid for each logged session.
            </span>
          </label>
        ) : (
          // Keep the prior amount in the form payload even while hidden so
          // a hourly→per_session flip without re-typing still submits it.
          <input
            type="hidden"
            name="perSessionDollars"
            defaultValue={seededDollars}
          />
        )}

        <div className="flex items-center justify-end gap-2">
          <button
            type="submit"
            disabled={pending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-gold text-gold-ink hover:bg-gold-hover shadow-[var(--shadow-sm)] h-9 px-4 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
          >
            <Check className="h-4 w-4" strokeWidth={2.5} />
            {pending ? "Saving…" : "Save pay mode"}
          </button>
        </div>
      </form>
    </section>
  );
}
