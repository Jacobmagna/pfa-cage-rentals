"use client";

// Slot-length picker for the multi-slot session flow. Offers
// 30 min / 1 hr / Custom — the first two stay single-click radio
// buttons (single-click discoverability beats a dropdown), and
// Custom reveals a small minutes input for any other positive
// length.
//
// Controlled. The parent owns the value (a number of minutes)
// because both the slot-count label and the per-slot card list
// react to it. A `value` that isn't 30 or 60 puts the control in
// "Custom" mode with the input prefilled to that value.
//
// `size="sm"` renders a compact segmented micro-control (used on the
// coach Log-session form so the toggle reads as clearly secondary to
// the Start/End time selectors). Default keeps the original size so
// admin surfaces are unchanged.

import { useState } from "react";

// A value not equal to either preset (30 / 60) means the control is in
// Custom mode.

type Props = {
  value: number;
  onChange: (v: number) => void;
  className?: string;
  size?: "default" | "sm";
};

const isPreset = (v: number) => v === 30 || v === 60;

export function SlotLengthToggle({
  value,
  onChange,
  className,
  size = "default",
}: Props) {
  const small = size === "sm";

  // User intent to be in Custom mode even while `value` is still a
  // preset (so the input can appear before they type a non-preset
  // length). Only ever set by event handlers — never by an effect.
  const [customIntent, setCustomIntent] = useState(false);
  // Text mirror of the custom input so an empty/partial field doesn't
  // snap back to a number while typing. Only meaningful while
  // `customMode` is on. Tracks the user's keystrokes; when null we
  // fall back to deriving the field from `value`.
  const [customText, setCustomText] = useState<string | null>(null);

  // When the PARENT drives `value` to a preset (e.g. a form reset back
  // to 30), the input should collapse. We detect a genuine parent-side
  // value change by remembering the value from the previous render and
  // clearing the intent flag — done during render (the React-blessed
  // "adjust state while rendering" pattern), so NO effect is involved.
  const [prevValue, setPrevValue] = useState(value);
  if (value !== prevValue) {
    setPrevValue(value);
    if (isPreset(value)) {
      setCustomIntent(false);
      setCustomText(null);
    }
  }

  // `customMode` is DERIVED during render: a non-preset value is
  // inherently custom, or the user explicitly asked for Custom.
  const customMode = customIntent || !isPreset(value);

  const inputValue =
    customText ?? (isPreset(value) ? "" : String(value));

  const selectPreset = (v: number) => {
    setCustomIntent(false);
    setCustomText(null);
    onChange(v);
  };

  const enterCustom = () => {
    setCustomIntent(true);
    // Seed the input from the current value so it's never blank on
    // entry — if the current value is a preset, reuse it as a sane
    // starting point.
    const seed = value > 0 ? value : 30;
    setCustomText(String(seed));
    if (!isPreset(value)) {
      // already a custom value — keep it
      onChange(value);
    } else {
      onChange(seed);
    }
  };

  const handleCustomText = (raw: string) => {
    setCustomText(raw);
    const n = Math.floor(Number(raw));
    if (raw.trim() === "" || !Number.isFinite(n) || n < 1) {
      // Ignore empty / invalid while typing — don't push a bad value
      // up. Parent keeps the last valid length.
      return;
    }
    onChange(n);
  };

  return (
    <div
      className={`inline-flex flex-wrap items-center gap-2 ${className ?? ""}`}
    >
      <div
        role="radiogroup"
        aria-label="Slot length"
        className={`inline-flex rounded-lg border border-line bg-surface-2 ${
          small ? "p-px" : "p-0.5"
        }`}
      >
        <Option
          active={!customMode && value === 30}
          onClick={() => selectPreset(30)}
          label="30 min"
          small={small}
        />
        <Option
          active={!customMode && value === 60}
          onClick={() => selectPreset(60)}
          label="1 hr"
          small={small}
        />
        <Option
          active={customMode}
          onClick={enterCustom}
          label="Custom"
          small={small}
        />
      </div>

      {customMode ? (
        <label className="inline-flex items-center gap-1.5">
          <span className="sr-only">Custom slot length in minutes</span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            value={inputValue}
            onChange={(e) => handleCustomText(e.target.value)}
            aria-label="Custom slot length in minutes"
            className={[
              small
                ? "w-16 h-7 text-[11px]"
                : "w-20 h-8 text-xs",
              "rounded-md border border-line bg-surface text-fg px-2 text-center font-medium tabular-nums focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40",
            ].join(" ")}
          />
          <span
            className={
              small ? "text-[11px] text-fg-muted" : "text-xs text-fg-muted"
            }
          >
            min
          </span>
        </label>
      ) : null}
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
