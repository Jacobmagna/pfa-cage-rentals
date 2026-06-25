"use client";

// Per-coach PROGRAM rate override editor. Mirrors rate-overrides-card.tsx
// but with one row per ACTIVE program (not per resource type), showing the
// program name, its default pay rate (or "—" when unset), and inline forms
// to save or remove this coach's override for that program.
//
// DESIGN-1: each row now also carries a per-program PAY MODE toggle —
// Hourly (the per-30-min rate, entered/displayed per hour) vs Per session
// (a flat per-session dollar amount). BOTH amount fields are always
// rendered as CONTROLLED inputs with independent state, so the payload
// always carries both `rateDollars` and `perSessionDollars` (the server
// reads only the one matching `payMode`). The mode toggle only swaps which
// field is visible — values NEVER bleed across a mode flip (the two inputs
// are stable, distinctly-keyed DOM nodes, so React never reconciles them as
// the same element).
//
// Each row owns its own useActionState for the save form so error states
// don't bleed between rows. Remove uses useTransition + the public
// deleteProgramRateOverride action; revalidatePath in the action refreshes
// the parent page so the row re-renders without an override.

import { useActionState, useState, useTransition } from "react";
import { Check, Trash2 } from "lucide-react";
import { deleteProgramRateOverride } from "../actions";
import {
  upsertProgramRateOverrideFormAction,
  type ProgramRateOverrideActionResult,
} from "../form-actions";
import { formatPfaDateMedium } from "@/lib/timezone";
import { ConfirmDialog } from "@/app/_components/confirm-dialog";

const INITIAL_STATE: ProgramRateOverrideActionResult = { ok: true };

type PayMode = "hourly" | "per_session";

export type ProgramRateOverrideRow = {
  programId: string;
  programName: string;
  /** Program's default pay rate per 30 min, in cents. null = unset. */
  defaultCents: number | null;
  override: {
    payMode: PayMode;
    /** Per-30-min cents for hourly overrides; null for per-session. */
    ratePer30MinCents: number | null;
    /** Flat per-session cents for per-session overrides; null for hourly. */
    perSessionRateCents: number | null;
    updatedAt: Date;
  } | null;
};

export function ProgramRateOverridesCard({
  coachId,
  rows,
}: {
  coachId: string;
  rows: ProgramRateOverrideRow[];
}) {
  return (
    <section className="rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)] overflow-hidden mt-6">
      <header className="px-5 py-4 border-b border-line">
        <h3 className="text-base font-semibold text-fg">Work rates</h3>
        <p className="mt-1 text-xs text-fg-muted leading-relaxed">
          Override the standard pay rate for this coach per work type. Pick
          how each is paid — hourly or a flat per-session amount. Changes
          apply to{" "}
          <span className="text-fg">future hours only</span> — past logged
          hours stay at the rate they were stamped with.
        </p>
      </header>
      {rows.length === 0 ? (
        <p className="px-5 py-6 text-sm text-fg-muted">
          No active programs yet.
        </p>
      ) : (
        <div className="divide-y divide-line/60">
          {rows.map((row) => (
            <Row key={row.programId} coachId={coachId} row={row} />
          ))}
        </div>
      )}
    </section>
  );
}

function Row({
  coachId,
  row,
}: {
  coachId: string;
  row: ProgramRateOverrideRow;
}) {
  const [state, action, pending] = useActionState(
    upsertProgramRateOverrideFormAction,
    INITIAL_STATE,
  );
  const [removing, startRemove] = useTransition();
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const hasOverride = row.override !== null;
  // Rates are STORED per 30 min but DISPLAYED/ENTERED per hour, so show
  // the hourly dollars (stored cents × 2 / 100).
  const defaultDollars =
    row.defaultCents !== null ? formatHourlyDollars(row.defaultCents) : null;

  // Seed the hourly + per-session fields independently from the stored
  // override (whichever mode it was). On a validation error, echo the
  // admin's submitted values so nothing is lost.
  const overrideMode: PayMode = row.override?.payMode ?? "hourly";
  const overrideHourly =
    row.override && row.override.ratePer30MinCents !== null
      ? formatHourlyDollars(row.override.ratePer30MinCents)
      : "";
  const overrideFlat =
    row.override && row.override.perSessionRateCents !== null
      ? formatFlatDollars(row.override.perSessionRateCents)
      : "";

  const seededMode: PayMode = !state.ok ? state.values.payMode : overrideMode;
  const seededHourly = !state.ok ? state.values.rateDollars : overrideHourly;
  const seededFlat = !state.ok
    ? state.values.perSessionDollars
    : overrideFlat;

  // Controlled mode so the amount field swaps live as the admin toggles.
  const [mode, setMode] = useState<PayMode>(seededMode);

  // The two amount fields are CONTROLLED with INDEPENDENT state so a value
  // typed in one mode can never bleed into the other when the admin toggles
  // (the old uncontrolled defaultValue inputs shared a DOM position and
  // React reconciled them as one node, leaking e.g. a per-session "$100"
  // into the hourly field → a silent pay-basis flip on Save). Seeded from
  // the same seededHourly/seededFlat values; the formKey remount re-runs
  // these useState calls so a successful save re-seeds from refreshed props.
  const [hourlyVal, setHourlyVal] = useState(seededHourly);
  const [flatVal, setFlatVal] = useState(seededFlat);

  // Re-key the form when the override changes (server re-fetched) or on a
  // validation error. Re-keying remounts the form so the controlled mode +
  // defaultValues re-seed. Include payMode + both amounts so a same-cents
  // mode flip still re-seeds.
  const formKey = state.ok
    ? `${row.programId}-${overrideMode}-${
        row.override?.ratePer30MinCents ?? "none"
      }-${row.override?.perSessionRateCents ?? "none"}`
    : `${row.programId}-err-${state.error.code}-${state.error.message}`;

  const handleRemove = () => {
    if (!hasOverride) return;
    setRemoveError(null);
    setConfirmOpen(true);
  };

  const handleConfirmRemove = () => {
    startRemove(async () => {
      try {
        await deleteProgramRateOverride(coachId, row.programId);
        setConfirmOpen(false);
      } catch (err) {
        setRemoveError(
          err instanceof Error
            ? err.message
            : "Couldn't remove the override.",
        );
        setConfirmOpen(false);
      }
    });
  };

  return (
    <form
      action={action}
      key={formKey}
      className="px-5 py-4 grid grid-cols-1 sm:grid-cols-[minmax(160px,1.2fr)_110px_1fr_auto] sm:items-start gap-3"
    >
      <input type="hidden" name="coachId" defaultValue={coachId} />
      <input type="hidden" name="programId" defaultValue={row.programId} />
      <input type="hidden" name="payMode" value={mode} readOnly />

      <div className="min-w-0">
        <p className="text-sm font-medium text-fg break-words leading-snug">
          {row.programName}
        </p>
        {row.override ? (
          <p className="text-[10px] text-fg-subtle mt-0.5">
            Updated {formatPfaDateMedium(row.override.updatedAt)}
          </p>
        ) : (
          <p className="text-[10px] text-fg-subtle mt-0.5">Using default</p>
        )}
      </div>

      {/* Left column: in hourly mode show the program's default hourly rate;
          in per-session mode the hourly default is irrelevant, so show a
          plain "—" with a "per session" caption. Driven by controlled mode
          so the toggle visibly updates this column live. */}
      <div className="hidden sm:block text-xs text-fg-muted">
        <p className="font-mono tnum tabular-nums">
          {mode === "per_session"
            ? "—"
            : defaultDollars !== null
              ? `$${defaultDollars}`
              : "—"}
        </p>
        <p className="text-[10px] text-fg-subtle uppercase tracking-wider mt-0.5">
          {mode === "per_session" ? "per session" : "default / hr"}
        </p>
      </div>

      <div className="min-w-0">
        {/* Mode toggle (segmented). The hidden payMode input above mirrors
            this so the payload carries the selected mode. It ONLY swaps which
            amount field is visible — it never clears or copies either value. */}
        <div
          role="radiogroup"
          aria-label={`Pay mode for ${row.programName}`}
          className="inline-flex rounded-lg border border-line p-0.5 mb-2"
        >
          <button
            type="button"
            role="radio"
            aria-checked={mode === "hourly"}
            onClick={() => setMode("hourly")}
            className={`px-3 h-7 rounded-md text-xs font-medium transition-colors ${
              mode === "hourly"
                ? "bg-gold text-gold-ink shadow-[var(--shadow-sm)]"
                : "text-fg-muted hover:text-fg"
            }`}
          >
            Hourly
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === "per_session"}
            onClick={() => setMode("per_session")}
            className={`px-3 h-7 rounded-md text-xs font-medium transition-colors ${
              mode === "per_session"
                ? "bg-gold text-gold-ink shadow-[var(--shadow-sm)]"
                : "text-fg-muted hover:text-fg"
            }`}
          >
            Per session
          </button>
        </div>

        {/* BOTH fields are ALWAYS rendered as stable, distinctly-keyed,
            CONTROLLED inputs so the payload always carries both names and
            values never bleed across a mode toggle. The inactive field's
            CONTAINER is `hidden` (HTML hidden attr) — the <input> stays in
            the DOM with name + controlled value so it still submits. */}
        <div hidden={mode !== "hourly"}>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle text-sm">
              $
            </span>
            <input
              key="rate"
              type="text"
              inputMode="decimal"
              name="rateDollars"
              value={hourlyVal}
              onChange={(e) => setHourlyVal(e.target.value)}
              placeholder={defaultDollars ?? "0.00"}
              aria-label={`Override hourly pay rate for ${row.programName}`}
              className="w-full pl-7 pr-3 h-10 rounded-lg bg-surface border border-line text-fg placeholder:text-fg-subtle text-sm focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40"
            />
          </div>
          <span className="block text-[10px] text-fg-subtle mt-1">
            Per hour
          </span>
        </div>
        <div hidden={mode !== "per_session"}>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle text-sm">
              $
            </span>
            <input
              key="persession"
              type="text"
              inputMode="decimal"
              name="perSessionDollars"
              value={flatVal}
              onChange={(e) => setFlatVal(e.target.value)}
              placeholder="0.00"
              aria-label={`Per-session pay amount for ${row.programName}`}
              className="w-full pl-7 pr-3 h-10 rounded-lg bg-surface border border-line text-fg placeholder:text-fg-subtle text-sm focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40"
            />
          </div>
          <span className="block text-[10px] text-fg-subtle mt-1">
            Flat per session
          </span>
        </div>

        {!state.ok ? (
          <p role="alert" className="mt-1 text-[11px] text-danger">
            {state.error.message}
          </p>
        ) : null}
        {removeError ? (
          <p role="alert" className="mt-1 text-[11px] text-danger">
            {removeError}
          </p>
        ) : null}
      </div>

      <div className="flex items-center gap-2 sm:justify-self-end">
        <button
          type="submit"
          disabled={pending || removing}
          className="inline-flex items-center justify-center gap-1 rounded-lg bg-gold text-gold-ink hover:bg-gold-hover shadow-[var(--shadow-sm)] h-9 px-3 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
        >
          <Check className="h-3.5 w-3.5" />
          {pending ? "Saving…" : "Save"}
        </button>
        {hasOverride ? (
          <button
            type="button"
            onClick={handleRemove}
            disabled={pending || removing}
            className="inline-flex items-center justify-center h-9 w-9 rounded-lg border border-line-strong text-fg-muted hover:text-danger hover:border-danger/40 hover:bg-danger/10 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 transition-colors"
            aria-label={`Remove override for ${row.programName}`}
            title="Remove override"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={(next) => {
          if (!removing) setConfirmOpen(next);
        }}
        title="Remove this work rate override?"
        description={
          <>
            Future work for {row.programName} will pay at the program
            default
            {defaultDollars !== null
              ? ` of $${defaultDollars} per hr`
              : " (none set)"}
            . Past logged hours keep the rate they were stamped with.
          </>
        }
        confirmLabel={removing ? "Removing…" : "Remove override"}
        onConfirm={handleConfirmRemove}
        isPending={removing}
      />
    </form>
  );
}

// Stored cents are PER 30 MIN; the UI shows hourly rates PER HOUR, so double.
function formatHourlyDollars(centsPer30Min: number): string {
  return ((centsPer30Min * 2) / 100).toFixed(2);
}

// Per-session cents are a FLAT amount — no ×2.
function formatFlatDollars(cents: number): string {
  return (cents / 100).toFixed(2);
}
