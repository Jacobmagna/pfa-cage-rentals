"use client";

// Editor for the rate_defaults table — three rows, one per resource
// type. Same dashboard look as the OrgSettingsCard above.
//
// Edits to defaults only apply to NEW sessions; historical sessions
// keep their stamped ratePer30MinCents. This guarantee is enforced
// in the read path (src/lib/reports/aggregate.ts reads the snapshot;
// /admin/sessions reads the snapshot).

import { useActionState } from "react";
import { Check, CheckCircle2 } from "lucide-react";
import {
  updateRateDefaultsFormAction,
  type RateDefaultsActionResult,
} from "../form-actions";
import { formatPfaDateMedium } from "@/lib/timezone";

const INITIAL_STATE: RateDefaultsActionResult = { ok: true, savedAt: 0 };

export type RateDefaultsRow = {
  type: "cage" | "bullpen" | "weight_room";
  ratePer30MinCents: number;
  /**
   * Weight-room ONLY: the FACILITY-WIDE group weight-room rate, if set.
   * null = no group rate configured → group weight-room sessions fall back
   * to the regular weight-room rate. Stored per 30 min, ENTERED/DISPLAYED
   * per hour like the regular weight-room rate.
   */
  groupRatePer30MinCents: number | null;
  updatedAt: Date;
};

const RESOURCE_LABEL: Record<RateDefaultsRow["type"], string> = {
  cage: "Cages",
  bullpen: "Bullpens",
  weight_room: "Weight Room",
};

const FIELD_NAME: Record<RateDefaultsRow["type"], string> = {
  cage: "cageDollars",
  bullpen: "bullpenDollars",
  weight_room: "weightRoomDollars",
};

// Cage & bullpen are entered + displayed per 30 min; weight room is
// per hour (stored per-30-min cents, converted on save/display).
const FIELD_UNIT: Record<RateDefaultsRow["type"], string> = {
  cage: "/ 30 min",
  bullpen: "/ 30 min",
  weight_room: "/ hr",
};

export function RateDefaultsCard({ rows }: { rows: RateDefaultsRow[] }) {
  const [state, action, pending] = useActionState(
    updateRateDefaultsFormAction,
    INITIAL_STATE,
  );

  const byType = new Map(rows.map((r) => [r.type, r]));

  const valueFor = (type: RateDefaultsRow["type"]): string => {
    if (!state.ok) {
      switch (type) {
        case "cage":
          return state.values.cageDollars;
        case "bullpen":
          return state.values.bullpenDollars;
        case "weight_room":
          return state.values.weightRoomDollars;
      }
    }
    const row = byType.get(type);
    if (!row) return "";
    // Weight room is entered + displayed PER HOUR (stored per-30-min cents,
    // so * 2). Cage & bullpen stay per-30-min. Mirrors the program-rate
    // per-hour pattern.
    if (type === "weight_room") {
      return ((row.ratePer30MinCents * 2) / 100).toFixed(2);
    }
    return (row.ratePer30MinCents / 100).toFixed(2);
  };

  // FACILITY-WIDE group weight-room rate. Same per-hour entry/display as the
  // regular weight-room rate (stored per 30 min). Blank = falls back to the
  // regular weight-room rate. Echoes the admin's typed value back on error.
  const groupValue = (): string => {
    if (!state.ok) return state.values.weightRoomGroupDollars;
    const row = byType.get("weight_room");
    if (!row || row.groupRatePer30MinCents == null) return "";
    return ((row.groupRatePer30MinCents * 2) / 100).toFixed(2);
  };

  const formKey = state.ok
    ? `ok-${state.savedAt}-${rows.map((r) => `${r.type}:${r.ratePer30MinCents}:${r.groupRatePer30MinCents ?? "none"}`).join("|")}`
    : `err-${state.error.code}-${state.error.message}`;

  const justSaved = state.ok && state.savedAt > 0;

  return (
    <section className="rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)] overflow-hidden">
      <header className="px-5 py-4 border-b border-line">
        <h2 className="text-base font-semibold text-fg">
          Default rental rates
        </h2>
        <p className="mt-1 text-xs text-fg-muted leading-relaxed">
          The standard rate for each resource type — see the unit beside
          each field. Changes apply to{" "}
          <span className="text-fg">future sessions only</span> — past
          sessions stay at the rate they were billed at. Per-coach
          discounts override these on{" "}
          <span className="text-fg">/admin/coaches</span>.
        </p>
      </header>

      <form action={action} key={formKey} className="space-y-4 p-5">
        {!state.ok ? (
          <div
            role="alert"
            className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
          >
            {state.error.message}
          </div>
        ) : null}

        {justSaved ? (
          <div
            role="status"
            className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-xs text-success"
          >
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <span>Default rates saved.</span>
          </div>
        ) : null}

        <div className="space-y-3">
          {(["cage", "bullpen", "weight_room"] as const).map((type) => (
            <RateField
              key={type}
              label={RESOURCE_LABEL[type]}
              name={FIELD_NAME[type]}
              unit={FIELD_UNIT[type]}
              value={valueFor(type)}
              updatedAt={byType.get(type)?.updatedAt ?? null}
              groupValue={type === "weight_room" ? groupValue() : undefined}
            />
          ))}
        </div>

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="submit"
            disabled={pending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-gold text-gold-ink hover:bg-gold-hover shadow-[var(--shadow-sm)] h-9 px-4 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
          >
            <Check className="h-4 w-4" strokeWidth={2.5} />
            {pending ? "Saving…" : "Save defaults"}
          </button>
        </div>
      </form>
    </section>
  );
}

function RateField({
  label,
  name,
  unit,
  value,
  updatedAt,
  groupValue,
}: {
  label: string;
  name: string;
  unit: string;
  value: string;
  updatedAt: Date | null;
  /**
   * Weight-room ONLY: when provided, render a second per-HOUR input for the
   * FACILITY-WIDE group rate beneath the regular rate. Blank = unset (falls
   * back to the regular weight-room rate).
   */
  groupValue?: string;
}) {
  return (
    <div className="space-y-2">
      <label className="grid grid-cols-[1fr_140px] items-center gap-3">
        <span>
          <span className="block text-sm font-medium text-fg">{label}</span>
          {updatedAt ? (
            <span className="block text-[10px] text-fg-subtle mt-0.5">
              Updated {formatPfaDateMedium(updatedAt)}
            </span>
          ) : null}
        </span>
        <span className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle text-sm">
            $
          </span>
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-fg-subtle">
            {unit}
          </span>
          <input
            type="text"
            inputMode="decimal"
            name={name}
            defaultValue={value}
            aria-label={`Default rate for ${label} (${unit})`}
            className="w-full pl-7 pr-16 h-10 rounded-lg bg-surface border border-line text-fg text-sm tnum tabular-nums focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40"
          />
        </span>
      </label>
      {groupValue !== undefined ? (
        <label className="grid grid-cols-[1fr_140px] items-center gap-3">
          <span className="block text-xs text-fg-muted">
            Group rate
            <span className="block text-[10px] text-fg-subtle mt-0.5 leading-relaxed">
              Leave blank to bill group sessions at the regular rate.
            </span>
          </span>
          <span className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle text-sm">
              $
            </span>
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-fg-subtle">
              / hr
            </span>
            <input
              type="text"
              inputMode="decimal"
              name="weightRoomGroupDollars"
              defaultValue={groupValue}
              placeholder="—"
              aria-label="Facility-wide group weight room rate (/ hr)"
              className="w-full pl-7 pr-16 h-10 rounded-lg bg-surface border border-line text-fg placeholder:text-fg-subtle text-sm tnum tabular-nums focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40"
            />
          </span>
        </label>
      ) : null}
    </div>
  );
}
