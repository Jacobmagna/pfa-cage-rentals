"use client";

// Per-coach PROGRAM rate override editor. Mirrors rate-overrides-card.tsx
// but with one row per ACTIVE program (not per resource type), showing the
// program name, its default pay rate (or "—" when unset), and inline forms
// to save or remove this coach's override for that program.
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

export type ProgramRateOverrideRow = {
  programId: string;
  programName: string;
  /** Program's default pay rate per 30 min, in cents. null = unset. */
  defaultCents: number | null;
  override: {
    ratePer30MinCents: number;
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
          Override the standard pay rate for this coach per work type.
          Changes apply to{" "}
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
  const overrideDollars = row.override
    ? formatHourlyDollars(row.override.ratePer30MinCents)
    : "";

  // Re-key the form when the override changes (server re-fetched). Without
  // this, the input keeps its prior defaultValue across re-renders.
  const formKey = state.ok
    ? `${row.programId}-${row.override?.ratePer30MinCents ?? "none"}`
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

  // Use the user's submitted value on error so they don't lose their
  // typing; otherwise show the stored override (or blank).
  const inputDefault =
    !state.ok && state.values.rateDollars
      ? state.values.rateDollars
      : overrideDollars;

  return (
    <form
      action={action}
      key={formKey}
      className="px-5 py-4 grid grid-cols-[1fr_auto] sm:grid-cols-[140px_120px_1fr_auto] items-center gap-3"
    >
      <input type="hidden" name="coachId" defaultValue={coachId} />
      <input type="hidden" name="programId" defaultValue={row.programId} />

      <div className="min-w-0">
        <p className="text-sm font-medium text-fg truncate">
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

      <div className="hidden sm:block text-xs text-fg-muted">
        <p className="font-mono tnum tabular-nums">
          {defaultDollars !== null ? `$${defaultDollars}` : "—"}
        </p>
        <p className="text-[10px] text-fg-subtle uppercase tracking-wider mt-0.5">
          default / hr
        </p>
      </div>

      <div className="col-span-2 sm:col-span-1">
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle text-sm">
            $
          </span>
          <input
            type="text"
            inputMode="decimal"
            name="rateDollars"
            defaultValue={inputDefault}
            placeholder={defaultDollars ?? "0.00"}
            aria-label={`Override pay rate for ${row.programName}`}
            className="w-full pl-7 pr-3 h-10 rounded-lg bg-surface border border-line text-fg placeholder:text-fg-subtle text-sm focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40"
          />
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

      <div className="flex items-center gap-2 justify-self-end">
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

// Stored cents are PER 30 MIN; the UI shows rates PER HOUR, so double.
function formatHourlyDollars(centsPer30Min: number): string {
  return ((centsPer30Min * 2) / 100).toFixed(2);
}
