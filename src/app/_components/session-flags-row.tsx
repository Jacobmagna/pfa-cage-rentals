"use client";

// Horizontal pill-toggle row for session flag checkboxes. Replaces
// the stacked vanilla checkboxes — easier to scan and easier to fit
// three flags side-by-side without crowding the form.
//
// Each pill is a real <input type="checkbox"> with `appearance-none`
// and a styled <label> around it, so form-actions can still read
// `formData.get("isOnline") === "on"`. Controlled state drives the
// visual swap to the gold accent.
//
// Pass `showTeamRental={false}` on coach surfaces — coaches don't
// log team rentals, that's admin-only.

import { useEffect, useId, useState } from "react";
import { Users, ArrowDownToLine, Wifi } from "lucide-react";

type Defaults = {
  isTeamRental?: boolean;
  pfaReferred?: boolean;
  isOnline?: boolean;
};

export function SessionFlagsRow({
  defaults,
  showTeamRental = true,
}: {
  defaults: Defaults;
  showTeamRental?: boolean;
}) {
  const baseId = useId();
  const [state, setState] = useState({
    isTeamRental: defaults.isTeamRental ?? false,
    pfaReferred: defaults.pfaReferred ?? false,
    isOnline: defaults.isOnline ?? false,
  });

  // Re-seed when the parent's defaults change (e.g. opening the edit
  // dialog on a different row, or a post-error form re-render).
  const [prev, setPrev] = useState(defaults);
  if (defaults !== prev) {
    setPrev(defaults);
    setState({
      isTeamRental: defaults.isTeamRental ?? false,
      pfaReferred: defaults.pfaReferred ?? false,
      isOnline: defaults.isOnline ?? false,
    });
  }

  useEffect(() => {
    // No-op — placeholder to lock in the lint pattern in case we
    // later want to surface state to the parent via a callback.
  }, [state]);

  return (
    <div className="flex flex-wrap gap-2">
      {showTeamRental ? (
        <Pill
          id={`${baseId}-team`}
          name="isTeamRental"
          checked={state.isTeamRental}
          onChange={(v) => setState((s) => ({ ...s, isTeamRental: v }))}
          label="Team rental"
          icon={<Users className="h-3.5 w-3.5" />}
        />
      ) : null}
      <Pill
        id={`${baseId}-online`}
        name="isOnline"
        checked={state.isOnline}
        onChange={(v) => setState((s) => ({ ...s, isOnline: v }))}
        label="Prepaid online lesson"
        icon={<Wifi className="h-3.5 w-3.5" />}
      />
      <Pill
        id={`${baseId}-pfa`}
        name="pfaReferred"
        checked={state.pfaReferred}
        onChange={(v) => setState((s) => ({ ...s, pfaReferred: v }))}
        label="PFA-referred"
        icon={<ArrowDownToLine className="h-3.5 w-3.5" />}
      />
    </div>
  );
}

function Pill({
  id,
  name,
  checked,
  onChange,
  label,
  icon,
}: {
  id: string;
  name: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <label
      htmlFor={id}
      className={`inline-flex items-center gap-1.5 cursor-pointer select-none rounded-full border px-3 h-8 text-xs font-medium transition-colors ${
        checked
          ? "border-gold/60 bg-gold/15 text-gold"
          : "border-line bg-surface text-fg-muted hover:border-line-strong hover:text-fg"
      }`}
    >
      <input
        id={id}
        type="checkbox"
        name={name}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="sr-only"
      />
      {icon}
      <span>{label}</span>
    </label>
  );
}
