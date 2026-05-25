// Strict 30-minute time picker for session + block forms. PFA's
// facility operates 8 AM–10 PM, all bookings round to 30-min slots
// (`SLOT_MINUTES = 30` in billing.ts), and the schedule grid only
// renders cells inside that window. Free-form <input type="time">
// with step={1800} lets browsers display a 30-min spinner but
// doesn't strictly prevent typing 8:17 or 11:00 PM, which the DB +
// app-layer validation would then reject after the user already
// committed their attention. A <select> rules out the mistake at
// the input boundary — frictionless replacement for the Excel
// sheet, which is the whole point.
//
// Two variants:
//   - "start": 08:00–21:30 (latest start that leaves at least one
//     30-min slot before close at 22:00)
//   - "end":   08:30–22:00 (earliest end that's after the earliest
//     start of 08:00)
//
// Output format is "HH:MM" (24-hour), matching what <input
// type="time"> would have produced, so the form-action callers
// don't need to change their parsing.

const FIRST_HOUR = 8;
const LAST_HOUR = 22;

function buildOptions(variant: "start" | "end"): { value: string; label: string }[] {
  const opts: { value: string; label: string }[] = [];
  // start: 08:00..21:30 inclusive
  // end:   08:30..22:00 inclusive
  const startMinutes =
    variant === "start" ? FIRST_HOUR * 60 : FIRST_HOUR * 60 + 30;
  const endMinutes =
    variant === "start" ? LAST_HOUR * 60 - 30 : LAST_HOUR * 60;
  for (let m = startMinutes; m <= endMinutes; m += 30) {
    const h = Math.floor(m / 60);
    const mm = m % 60;
    const value = `${pad(h)}:${pad(mm)}`;
    opts.push({ value, label: format12h(h, mm) });
  }
  return opts;
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function format12h(h: number, m: number): string {
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}:00 ${ampm}` : `${h12}:${pad(m)} ${ampm}`;
}

// Pre-compute once at module load — same options every render.
const START_OPTIONS = buildOptions("start");
const END_OPTIONS = buildOptions("end");

type TimeSelectProps = {
  name: string;
  variant: "start" | "end";
  defaultValue?: string;
  required?: boolean;
  className?: string;
  /** For controlled use, e.g. when the parent needs to update on change. */
  value?: string;
  onChange?: (value: string) => void;
  "aria-label"?: string;
};

export function TimeSelect({
  name,
  variant,
  defaultValue,
  required,
  className,
  value,
  onChange,
  "aria-label": ariaLabel,
}: TimeSelectProps) {
  const options = variant === "start" ? START_OPTIONS : END_OPTIONS;

  // Make sure the defaultValue is one of the offered options — if the
  // caller passes something stale (e.g. a legacy session at 9:15 from
  // an old import), prepend it so the select doesn't silently lose the
  // value. The form will still submit it as-is; server validation will
  // either accept or reject. This is a backstop, not the happy path.
  const hasDefault =
    defaultValue && options.some((o) => o.value === defaultValue);
  const augmentedOptions =
    !hasDefault && defaultValue
      ? [{ value: defaultValue, label: `${defaultValue} (non-standard)` }, ...options]
      : options;

  return (
    <select
      name={name}
      required={required}
      defaultValue={value === undefined ? defaultValue : undefined}
      value={value}
      onChange={onChange ? (e) => onChange(e.target.value) : undefined}
      aria-label={ariaLabel}
      className={className}
    >
      {augmentedOptions.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
