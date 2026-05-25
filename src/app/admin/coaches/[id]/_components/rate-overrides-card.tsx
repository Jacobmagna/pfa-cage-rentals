"use client";

// Per-coach rate override editor. One row per resource type (cage /
// bullpen / weight room) showing the default rate, the override
// rate (if set), and inline forms to save or remove the override.
//
// Each row owns its own useActionState for the save form so error
// states don't bleed between rows. Remove uses useTransition + the
// public deleteRateOverride action; revalidatePath in the action
// refreshes the parent page so the row re-renders without an
// override.

import { useActionState, useState, useTransition } from "react";
import { Check, Trash2 } from "lucide-react";
import type { ResourceType } from "@/lib/billing";
import { deleteRateOverride } from "../actions";
import {
  upsertRateOverrideFormAction,
  type RateOverrideActionResult,
} from "../form-actions";
import { formatPfaDateMedium } from "@/lib/timezone";

const INITIAL_STATE: RateOverrideActionResult = { ok: true };

const RESOURCE_LABEL: Record<ResourceType, string> = {
  cage: "Cages",
  bullpen: "Bullpens",
  weight_room: "Weight Room",
};

export type RateOverrideRow = {
  resourceType: ResourceType;
  defaultCents: number;
  override: {
    ratePer30MinCents: number;
    updatedAt: Date;
  } | null;
};

export function RateOverridesCard({
  coachId,
  rows,
}: {
  coachId: string;
  rows: RateOverrideRow[];
}) {
  return (
    <section className="rounded-xl border border-line bg-surface overflow-hidden">
      <header className="px-5 py-4 border-b border-line">
        <h3 className="text-base font-semibold text-fg">
          Rate overrides
        </h3>
        <p className="mt-1 text-xs text-fg-muted leading-relaxed">
          Override the standard rate for this coach per resource type.
          Changes apply to{" "}
          <span className="text-fg">future sessions only</span> — past
          sessions stay at the rate they were billed at.
        </p>
      </header>
      <div className="divide-y divide-line/60">
        {rows.map((row) => (
          <Row key={row.resourceType} coachId={coachId} row={row} />
        ))}
      </div>
    </section>
  );
}

function Row({
  coachId,
  row,
}: {
  coachId: string;
  row: RateOverrideRow;
}) {
  const [state, action, pending] = useActionState(
    upsertRateOverrideFormAction,
    INITIAL_STATE,
  );
  const [removing, startRemove] = useTransition();
  const [removeError, setRemoveError] = useState<string | null>(null);

  const hasOverride = row.override !== null;
  const defaultDollars = formatDollars(row.defaultCents);
  const overrideDollars = row.override
    ? formatDollars(row.override.ratePer30MinCents)
    : "";

  // Re-key the form when the override changes (server re-fetched).
  // Without this, the input keeps its prior defaultValue across
  // optimistic re-renders.
  const formKey = state.ok
    ? `${row.resourceType}-${row.override?.ratePer30MinCents ?? "none"}`
    : `${row.resourceType}-err-${state.error.code}-${state.error.message}`;

  const handleRemove = () => {
    if (!hasOverride) return;
    if (
      !confirm(
        `Remove the override for ${RESOURCE_LABEL[row.resourceType]}? Future sessions will bill at the default of $${defaultDollars} per 30 min.`,
      )
    ) {
      return;
    }
    setRemoveError(null);
    startRemove(async () => {
      try {
        await deleteRateOverride(coachId, row.resourceType);
      } catch (err) {
        setRemoveError(
          err instanceof Error
            ? err.message
            : "Couldn't remove the override.",
        );
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
      <input
        type="hidden"
        name="resourceType"
        defaultValue={row.resourceType}
      />

      <div className="min-w-0">
        <p className="text-sm font-medium text-fg">
          {RESOURCE_LABEL[row.resourceType]}
        </p>
        {row.override ? (
          <p className="text-[10px] text-fg-subtle mt-0.5">
            Updated {formatPfaDateMedium(row.override.updatedAt)}
          </p>
        ) : (
          <p className="text-[10px] text-fg-subtle mt-0.5">
            Using default
          </p>
        )}
      </div>

      <div className="hidden sm:block text-xs text-fg-muted">
        <p className="font-mono tabular-nums">${defaultDollars}</p>
        <p className="text-[10px] text-fg-subtle uppercase tracking-wider mt-0.5">
          default / 30 min
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
            placeholder={defaultDollars}
            aria-label={`Override rate for ${RESOURCE_LABEL[row.resourceType]}`}
            className="w-full pl-7 pr-3 h-10 rounded-md bg-page border border-line text-fg placeholder:text-fg-subtle text-sm focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40"
          />
        </div>
        {!state.ok ? (
          <p
            role="alert"
            className="mt-1 text-[11px] text-danger"
          >
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
          className="inline-flex items-center justify-center gap-1 rounded-md bg-gold text-gold-ink hover:bg-gold-hover h-9 px-3 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
        >
          <Check className="h-3.5 w-3.5" />
          {pending ? "Saving…" : "Save"}
        </button>
        {hasOverride ? (
          <button
            type="button"
            onClick={handleRemove}
            disabled={pending || removing}
            className="inline-flex items-center justify-center h-9 w-9 rounded-md border border-line text-fg-muted hover:text-danger hover:border-danger/40 hover:bg-danger/10 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 transition-colors"
            aria-label={`Remove override for ${RESOURCE_LABEL[row.resourceType]}`}
            title="Remove override"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        ) : null}
      </div>
    </form>
  );
}

function formatDollars(cents: number): string {
  return (cents / 100).toFixed(2);
}
