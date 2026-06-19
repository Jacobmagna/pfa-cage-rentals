"use client";

import { useState } from "react";

// Typable masked time field — a drop-in replacement for native
// <input type="time">. The coach types a flexible time ("2:30 PM",
// "230pm", "1430", "2pm", "2"…) and on resolve the value SNAPS to the
// nearest 30-minute boundary (Jacob's explicit decision). There's NO
// native spinner and NO dropdown — typing is far lower friction than the
// minute-by-minute mobile spinner Jacob flagged.
//
// Canonical value is `"HH:MM"` 24-hour — exactly what the native input
// emitted — carried in a hidden <input name={name}> so the server
// receives the SAME field name and string it does today. No server
// action / Zod schema changes. When the typed time is empty or
// unparseable the hidden value is "" (server Zod already handles it).
//
// All parse/format helpers are PURE string/arithmetic work — NO
// `new Date()` that could introduce a timezone drift.

/**
 * Flexible-parse a typed time, snap to the nearest 30 minutes, clamp to
 * [00:00, 23:30], and return canonical `"HH:MM"` 24-hour (zero-padded).
 * Empty / unparseable input → "".
 *
 * Accepted forms (lenient on separators, spacing, case):
 *   "2:30 PM", "2:30pm", "230pm", "2 30 pm", "2pm", "2",
 *   "14:30", "1430", "12:00 am", "12:00 pm".
 *
 * Snap rule (on the parsed minute): 0–14 → :00, 15–44 → :30,
 * 45–59 → round up to next hour :00. Then clamp so 23:45+ → 23:30.
 */
export function parseTimeToHHMM(raw: string): string {
  if (raw == null) return "";
  const s = raw.trim().toLowerCase();
  if (s === "") return "";

  // Detect an explicit am/pm marker anywhere in the string.
  let meridiem: "am" | "pm" | null = null;
  if (/\bp\.?m\.?\b|p\.?m\.?$|pm/.test(s)) meridiem = "pm";
  else if (/\ba\.?m\.?\b|a\.?m\.?$|am/.test(s)) meridiem = "am";

  // Strip everything but digits; the digit run carries the time.
  const digits = s.replace(/\D/g, "");
  if (digits.length === 0) return "";

  let hour: number;
  let minute: number;

  if (digits.length <= 2) {
    // "2", "14" → hour only.
    hour = Number(digits);
    minute = 0;
  } else if (digits.length === 3) {
    // "230" → H:MM.
    hour = Number(digits.slice(0, 1));
    minute = Number(digits.slice(1));
  } else {
    // 4+ digits → HH:MM (ignore any overflow beyond 4).
    hour = Number(digits.slice(0, 2));
    minute = Number(digits.slice(2, 4));
  }

  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return "";
  if (minute > 59) return "";

  // Apply meridiem if present (12-hour → 24-hour).
  if (meridiem) {
    if (hour < 1 || hour > 12) return "";
    if (meridiem === "am") {
      if (hour === 12) hour = 0; // 12 AM = midnight (00)
    } else {
      if (hour !== 12) hour += 12; // 1–11 PM → +12; 12 PM stays 12
    }
  } else if (digits.length <= 3 && hour >= 1 && hour <= 7) {
    // No am/pm typed: a bare 12-hour-style hour of 1–7 means afternoon/
    // evening at this facility (open 8 AM–10 PM), so default it to PM
    // (1–7 → 13:00–19:00). 8–11 stay AM (morning camps), 12 stays noon,
    // and 0 / 13–23 / 4-digit 24h entries like "1430" are left literal.
    // An explicit "am" still overrides (e.g. "3am" → 03:00). Jacob's QA
    // decision 2026-06-18: bare hours default toward PM.
    hour += 12;
  }

  if (hour > 23) return "";

  // Snap minute to nearest 30, carrying into the hour on round-up.
  if (minute <= 14) {
    minute = 0;
  } else if (minute <= 44) {
    minute = 30;
  } else {
    minute = 0;
    hour += 1;
  }

  // Clamp to [00:00, 23:30] — never 24:00.
  if (hour > 23) {
    hour = 23;
    minute = 30;
  }
  if (hour < 0) {
    hour = 0;
    minute = 0;
  }

  return `${pad2(hour)}:${pad2(minute)}`;
}

/**
 * Canonical `"HH:MM"` 24-hour → friendly 12-hour display ("2:30 PM").
 * "" / malformed → "". Pure arithmetic; no Date.
 */
export function formatHHMMTo12h(hhmm: string): string {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm ?? "");
  if (!m) return "";
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return "";
  const meridiem = hour < 12 ? "AM" : "PM";
  let h12 = hour % 12;
  if (h12 === 0) h12 = 12;
  return `${h12}:${pad2(minute)} ${meridiem}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

const BASE_STYLES =
  "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg placeholder:text-fg-subtle focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40";

type TimeInputProps = {
  /** Hidden-input field name the server reads (same as the old time input). */
  name?: string;
  /** Controlled canonical value (`"HH:MM"` 24h or ""). */
  value?: string;
  /** Uncontrolled initial canonical value (`"HH:MM"` 24h). */
  defaultValue?: string;
  /** Controlled change handler — receives canonical `"HH:MM"` (or ""). */
  onChange?: (hhmm: string) => void;
  required?: boolean;
  disabled?: boolean;
  id?: string;
  className?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
};

export function TimeInput({
  name,
  value,
  defaultValue,
  onChange,
  required,
  disabled,
  id,
  className,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedby,
}: TimeInputProps) {
  const controlled = value !== undefined;

  // Visible friendly text. We keep our own text so partial / mid-typing
  // input stays visible for correction; on blur we normalize it to the
  // snapped 12-hour display so the coach sees exactly what was recorded.
  const [text, setText] = useState(() =>
    formatHHMMTo12h(controlled ? (value ?? "") : (defaultValue ?? "")),
  );

  // In controlled mode, re-sync our text when the parent value changes
  // out from under us (e.g. a form reset / re-seed) and our current text
  // doesn't already resolve to that value — without clobbering a
  // mid-typing partial that hasn't resolved yet.
  if (controlled) {
    const incoming = value ?? "";
    if (parseTimeToHHMM(text) !== incoming) {
      if (incoming !== "") {
        const display = formatHHMMTo12h(incoming);
        if (display !== text) setText(display);
      } else if (text !== "" && parseTimeToHHMM(text) !== "") {
        // Parent cleared a previously-valid value → clear our text too.
        setText("");
      }
    }
  }

  const hhmm = parseTimeToHHMM(text);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.value;
    setText(next);
    if (onChange) onChange(parseTimeToHHMM(next));
  };

  const handleBlur = () => {
    // Normalize the field to the snapped 12-hour display once it cleanly
    // resolves; leave unparseable text alone so the coach can fix it.
    const resolved = parseTimeToHHMM(text);
    if (resolved !== "") {
      const display = formatHHMMTo12h(resolved);
      if (display !== text) setText(display);
    }
  };

  return (
    <>
      <input
        type="text"
        inputMode="text"
        autoComplete="off"
        placeholder="e.g. 2:30 PM"
        value={text}
        onChange={handleChange}
        onBlur={handleBlur}
        // Constraint-validation backstop for required: a `required` text
        // input with no `name` still participates in form validity, so an
        // empty field blocks submit. The accepted text formats vary too
        // much for a brittle `pattern`, so we rely on required (non-empty)
        // plus server validation. The hidden input below carries the real
        // submitted "HH:MM".
        required={required}
        disabled={disabled}
        id={id}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedby}
        className={className ?? BASE_STYLES}
      />
      {name ? <input type="hidden" name={name} value={hhmm} /> : null}
    </>
  );
}
