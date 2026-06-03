// Binary 30-min vs 60-min radio toggle for the multi-slot session
// flow. Stays a radio (not a select) because there are only ever
// two options and the choice drives the rest of the form's behavior
// — single-click discoverability beats a dropdown here.
//
// Controlled. The parent owns the value because both the slot-count
// label and the per-slot card list need to react to it.
//
// `size="sm"` renders a compact segmented micro-control (used on the
// coach Log-session form so the toggle reads as clearly secondary to
// the Start/End time selectors). Default keeps the original size so
// admin surfaces are unchanged.

type Props = {
  value: 30 | 60;
  onChange: (v: 30 | 60) => void;
  className?: string;
  size?: "default" | "sm";
};

export function SlotLengthToggle({
  value,
  onChange,
  className,
  size = "default",
}: Props) {
  const small = size === "sm";
  return (
    <div
      role="radiogroup"
      aria-label="Slot length"
      className={`inline-flex rounded-lg border border-line bg-surface-2 ${
        small ? "p-px" : "p-0.5"
      } ${className ?? ""}`}
    >
      <Option
        active={value === 30}
        onClick={() => onChange(30)}
        label="30 min"
        small={small}
      />
      <Option
        active={value === 60}
        onClick={() => onChange(60)}
        label="1 hr"
        small={small}
      />
    </div>
  );
}

function Option({
  active,
  onClick,
  label,
  small,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  small: boolean;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={[
        small
          ? "px-2.5 h-7 rounded-md border text-[11px] font-medium tracking-wide transition"
          : "px-3 h-8 rounded-md border text-xs font-medium tracking-wide transition",
        active
          ? "bg-gold/10 border-gold/40 text-gold-strong shadow-[var(--shadow-sm)]"
          : "border-transparent text-fg-muted hover:text-fg",
      ].join(" ")}
    >
      {label}
    </button>
  );
}
