"use client";

import { useState } from "react";

// Typable masked date field — a drop-in replacement for native
// <input type="date">. The user types digits and the field auto-inserts
// slashes to display MM/DD/YYYY; there's NO calendar popup (Jacob's
// explicit ask — typing is lower friction than the native picker on both
// desktop and mobile).
//
// Canonical value is ISO `YYYY-MM-DD` — exactly what the native input
// emitted — carried in a hidden <input name={name}> so the server
// receives the SAME field name and string it does today. No server
// action / Zod schema changes. When the typed date is incomplete or
// impossible the hidden ISO is "" (server Zod already handles empties /
// bad dates; we deliberately don't add client-only validation that would
// change the server contract).
//
// All parse/format helpers are pure string reshaping — NO `new Date()`
// parsing that could shift a day across a timezone boundary.

/**
 * Strip everything but digits, cap at 8 (MMDDYYYY), then group as
 * MM/DD/YYYY inserting slashes as the user types. Partial input keeps
 * whatever's typed so far (e.g. "0602" → "06/02").
 */
export function maskDigits(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 8);
  const mm = digits.slice(0, 2);
  const dd = digits.slice(2, 4);
  const yyyy = digits.slice(4, 8);
  let out = mm;
  if (digits.length > 2) out += "/" + dd;
  if (digits.length > 4) out += "/" + yyyy;
  return out;
}

/** ISO `YYYY-MM-DD` → masked `MM/DD/YYYY`. "" / malformed → "". */
export function isoToMasked(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "");
  if (!m) return "";
  const [, yyyy, mm, dd] = m;
  return `${mm}/${dd}/${yyyy}`;
}

/**
 * Masked `MM/DD/YYYY` → ISO `YYYY-MM-DD`. Returns "" unless the input is
 * a fully-typed, calendar-valid date (rejects month 13, day 32, Feb 30,
 * etc.). Pure: validity is checked by re-deriving the day count per
 * month — no Date construction.
 */
export function maskedToIso(masked: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(masked ?? "");
  if (!m) return "";
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return "";
  if (day > daysInMonth(year, month)) return "";
  return `${m[3]}-${m[1]}-${m[2]}`;
}

function daysInMonth(year: number, month: number): number {
  // month is 1-based. February leap handling via pure arithmetic.
  const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month === 2 && isLeapYear(year)) return 29;
  return lengths[month - 1];
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const BASE_STYLES =
  "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg placeholder:text-fg-subtle focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40";

type DateInputProps = {
  /** Hidden-input field name the server reads (same as the old date input). */
  name?: string;
  /** Controlled ISO value (`YYYY-MM-DD` or ""). */
  value?: string;
  /** Uncontrolled initial ISO value (`YYYY-MM-DD`). */
  defaultValue?: string;
  /** Controlled change handler — receives ISO (`YYYY-MM-DD` or ""). */
  onChange?: (iso: string) => void;
  required?: boolean;
  disabled?: boolean;
  id?: string;
  className?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
};

export function DateInput({
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
}: DateInputProps) {
  const controlled = value !== undefined;

  // Visible MM/DD/YYYY text. In controlled mode we keep our own text so
  // partial / invalid typing stays visible for correction; we re-sync it
  // to the parent's ISO whenever the parent value changes out from under
  // us (e.g. a form reset / re-seed) AND our current text doesn't already
  // map to that ISO.
  const [text, setText] = useState(() =>
    isoToMasked(controlled ? (value ?? "") : (defaultValue ?? "")),
  );

  if (controlled) {
    const incomingIso = value ?? "";
    if (maskedToIso(text) !== incomingIso) {
      const masked = isoToMasked(incomingIso);
      // Only adopt the parent value when it represents a different date
      // than what's typed; this avoids clobbering mid-typing partials
      // that haven't resolved to a valid ISO yet.
      if (masked !== text && incomingIso !== "") {
        setText(masked);
      } else if (incomingIso === "" && maskedToIso(text) !== "") {
        // Parent cleared a previously-valid value → clear our text too.
        setText("");
      }
    }
  }

  const iso = maskedToIso(text);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const masked = maskDigits(e.target.value);
    setText(masked);
    if (onChange) onChange(maskedToIso(masked));
  };

  return (
    <>
      <input
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder="MM/DD/YYYY"
        maxLength={10}
        value={text}
        onChange={handleChange}
        required={required}
        disabled={disabled}
        id={id}
        // Constraint-validation backstop for required: a `required` text
        // input with no name still participates in form validity, so an
        // empty field blocks submit. The pattern also blocks a half-typed
        // value. The hidden input below carries the real submitted ISO.
        pattern={required ? "\\d{2}/\\d{2}/\\d{4}" : undefined}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedby}
        className={className ?? BASE_STYLES}
      />
      {name ? <input type="hidden" name={name} value={iso} /> : null}
    </>
  );
}
