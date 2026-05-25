// Binary 30-min vs 60-min radio toggle for the multi-slot session
// flow. Stays a radio (not a select) because there are only ever
// two options and the choice drives the rest of the form's behavior
// — single-click discoverability beats a dropdown here.
//
// Controlled. The parent owns the value because both the slot-count
// label and the per-slot card list need to react to it.

type Props = {
  value: 30 | 60;
  onChange: (v: 30 | 60) => void;
  className?: string;
};

export function SlotLengthToggle({ value, onChange, className }: Props) {
  return (
    <div
      role="radiogroup"
      aria-label="Slot length"
      className={`inline-flex rounded-md border border-line bg-page p-0.5 ${
        className ?? ""
      }`}
    >
      <Option active={value === 30} onClick={() => onChange(30)} label="30 min" />
      <Option active={value === 60} onClick={() => onChange(60)} label="1 hr" />
    </div>
  );
}

function Option({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={[
        "px-3 h-8 rounded text-xs font-medium tracking-wide transition-colors",
        active
          ? "bg-surface-2 text-fg shadow-sm"
          : "text-fg-muted hover:text-fg",
      ].join(" ")}
    >
      {label}
    </button>
  );
}
