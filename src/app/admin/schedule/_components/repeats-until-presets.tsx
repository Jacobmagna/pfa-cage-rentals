"use client";

// QA-1: shared "Repeats until" duration-preset control. Bounded short-run
// scheduling — one tap fills the recurrence end date to "just this week / 2
// weeks / 4 weeks" instead of forcing the admin to hand-type an end date.
//
// Extracted (mirroring cage-picker.tsx) so ALL "repeats until" spots share
// ONE control: cage-block create (schedule-create-dialog BlockFields), cage-
// block series-edit (block-edit-dialog SeriesEditForm), and the work-log
// program-block dialog (create + apply-to-all series-edit).
//
// The presets are RELATIVE to the block's START date (`startsOn`, ISO
// YYYY-MM-DD) and INCLUSIVE:
//   This week → startsOn + 6 days · 2 weeks → +13 · 4 weeks → +27
// The parent tells us its current `startsOn`; when a preset is active we
// RE-DERIVE endsOn from it (via useEffect), so changing the start date while
// a preset is selected moves the end date with it. `Custom` stores a literal
// date (the manual DateInput) and never re-derives.
//
// The end value is always emitted as ISO YYYY-MM-DD through onEndsOnChange —
// the SAME shape the DateInput's onChange(iso) emits today — so submission is
// byte-identical whether the admin taps a chip or types manually.

import { useEffect, useState } from "react";
import { DateInput } from "@/app/_components/date-input";
import { weekdayFromIso } from "@/app/admin/hour-log/schedule/_components/recurrence-frequency.logic";

// Which duration the admin picked. "custom" = the manual DateInput; the
// three duration kinds re-derive endsOn from startsOn.
export type RepeatsUntilPresetKind = "week" | "2weeks" | "4weeks" | "custom";

// Inclusive day-offsets from the start date for each duration preset.
const PRESET_OFFSET_DAYS: Record<
  Exclude<RepeatsUntilPresetKind, "custom">,
  number
> = {
  week: 6,
  "2weeks": 13,
  "4weeks": 27,
};

const PRESET_CHIPS: {
  kind: RepeatsUntilPresetKind;
  label: string;
}[] = [
  { kind: "week", label: "This week" },
  { kind: "2weeks", label: "2 weeks" },
  { kind: "4weeks", label: "4 weeks" },
  { kind: "custom", label: "Custom" },
];

/**
 * Add `days` to an ISO `YYYY-MM-DD` date, returning a new ISO date. Pure
 * calendar math via Date.UTC (same UTC-anchored convention as
 * weekdayFromIso / the recurrence generator) so it never drifts with the
 * runtime timezone and rolls month/year boundaries correctly. Returns ""
 * for a malformed/empty input.
 */
export function addIsoDays(iso: string, days: number): string {
  if (weekdayFromIso(iso) === null) return "";
  const [y, m, d] = iso.split("-").map((p) => Number(p));
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  const yy = shifted.getUTCFullYear();
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(shifted.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/**
 * Compute the inclusive `endsOn` (ISO) for a duration preset given the
 * block's ISO `startsOn`. Returns "" when startsOn isn't a valid date yet
 * (so the field stays empty until the admin picks a start).
 */
export function endsOnForPreset(
  kind: Exclude<RepeatsUntilPresetKind, "custom">,
  startsOn: string,
): string {
  return addIsoDays(startsOn, PRESET_OFFSET_DAYS[kind]);
}

export function RepeatsUntilPresets({
  startsOn,
  endsOn,
  onEndsOnChange,
  initialKind = "custom",
  className,
  dateInputClassName,
}: {
  /** The block's start date (ISO YYYY-MM-DD) the presets derive from. */
  startsOn: string;
  /** Current end date (ISO YYYY-MM-DD or ""). */
  endsOn: string;
  /** Called with the computed/typed end date (ISO YYYY-MM-DD or ""). */
  onEndsOnChange: (iso: string) => void;
  /**
   * Which chip is selected on first mount. Series-edit seeds a literal
   * endsOn so it opens on "custom"; a fresh create with no endsOn also
   * opens on "custom" with the manual field empty (today's behavior).
   */
  initialKind?: RepeatsUntilPresetKind;
  className?: string;
  /** Optional className forwarded to the manual (Custom) DateInput so it
   * matches the surrounding form fields. */
  dateInputClassName?: string;
}) {
  const [kind, setKind] = useState<RepeatsUntilPresetKind>(initialKind);

  // When a duration preset is active, re-derive endsOn from the CURRENT
  // startsOn — so changing the start date moves the end date with it.
  // "custom" is inert here (literal date, no re-derivation). Guarded on a
  // real change so we don't fight the parent's controlled value.
  useEffect(() => {
    if (kind === "custom") return;
    const derived = endsOnForPreset(kind, startsOn);
    if (derived !== endsOn) onEndsOnChange(derived);
    // onEndsOnChange is a stable-enough parent setter; deriving only on
    // (kind, startsOn) change matches the "re-derive when start moves" rule.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, startsOn]);

  const selectPreset = (next: RepeatsUntilPresetKind) => {
    setKind(next);
    if (next !== "custom") {
      onEndsOnChange(endsOnForPreset(next, startsOn));
    }
    // "custom" leaves the current endsOn untouched so the admin edits from
    // wherever the field already sits.
  };

  return (
    <div className={className}>
      <div className="flex flex-wrap gap-1.5">
        {PRESET_CHIPS.map((chip) => {
          const on = kind === chip.kind;
          return (
            <button
              key={chip.kind}
              type="button"
              onClick={() => selectPreset(chip.kind)}
              aria-pressed={on}
              className={[
                "inline-flex items-center justify-center h-8 px-2.5 rounded-md border text-xs font-medium select-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40",
                on
                  ? "bg-gold/10 border-gold/40 text-gold-strong"
                  : "border-line text-fg-muted hover:text-fg hover:border-line-strong",
              ].join(" ")}
            >
              {chip.label}
            </button>
          );
        })}
      </div>

      {kind === "custom" ? (
        <div className="mt-2">
          <DateInput
            required
            value={endsOn}
            onChange={(iso) => onEndsOnChange(iso)}
            className={dateInputClassName}
          />
        </div>
      ) : null}
    </div>
  );
}
