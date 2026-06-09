"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

// Typable masked date field — a drop-in replacement for native
// <input type="date">. The user types digits and the field auto-inserts
// slashes to display MM/DD/YYYY; there's NO calendar popup (Jacob's
// explicit ask — typing is lower friction than the native picker on both
// desktop and mobile).
//
// The `/` separators are STRUCTURAL: the user only ever types digits, and
// backspace/delete removes the adjacent DIGIT (skipping the slash) — the
// slashes can never be typed, deleted, or stranded.
//
// Canonical value is ISO `YYYY-MM-DD` — exactly what the native input
// emitted — carried in a hidden <input name={name}> so the server
// receives the SAME field name and string it does today. No server
// action / Zod schema changes. When the typed date is incomplete or
// impossible the hidden ISO is "" (server Zod already handles empties /
// bad dates; we deliberately don't add client-only validation that would
// change the server contract).
//
// Current-year convenience: if the user types only MM + DD and leaves the
// year blank, we treat the year as the CURRENT calendar year — on blur we
// fill the visible year and the hidden ISO resolves. Partial input is
// never auto-filled or snapped back to a default mid-correction.
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

/**
 * Current-year convenience. If `masked` contains EXACTLY month + day (4
 * digits, no year — i.e. "MM/DD"), return "MM/DD/YYYY" using
 * `currentYear`. Otherwise (fewer than 4 digits, or a year already
 * present) return the input unchanged. Pure: the caller supplies
 * `currentYear` (its `new Date().getFullYear()` — the user's intended
 * "this year") so this helper stays testable and never constructs a Date.
 */
export function fillCurrentYear(masked: string, currentYear: number): string {
  const m = /^(\d{2})\/(\d{2})$/.exec(masked ?? "");
  if (!m) return masked;
  return `${masked}/${currentYear}`;
}

/**
 * Map a raw caret/string offset to a DIGIT index: how many digits sit
 * at-or-before `caret` in `masked`. Slashes are ignored, so the caret
 * position is tracked by the digit it follows — stable even as the mask
 * re-inserts slashes around it.
 */
export function caretToDigitIndex(masked: string, caret: number): number {
  let digits = 0;
  const end = Math.max(0, Math.min(caret, masked.length));
  for (let i = 0; i < end; i++) {
    if (/\d/.test(masked[i])) digits++;
  }
  return digits;
}

/**
 * Inverse of `caretToDigitIndex`: given a target number of digits, return
 * the string offset that lands the caret AFTER that many digits in
 * `masked`. When the offset falls right before a slash, we step past the
 * slash so the caret sits after the separator (matching how typing flows
 * MM → MM/ → MM/DD).
 */
export function digitIndexToCaret(masked: string, digitIndex: number): number {
  if (digitIndex <= 0) return 0;
  let digits = 0;
  for (let i = 0; i < masked.length; i++) {
    if (/\d/.test(masked[i])) {
      digits++;
      if (digits === digitIndex) {
        // Land after this digit; if a slash immediately follows, step
        // past it so the caret sits after the separator.
        let pos = i + 1;
        if (masked[pos] === "/") pos++;
        return pos;
      }
    }
  }
  return masked.length;
}

// ── Calendar-grid helpers (pure, tz-safe) ─────────────────────────────
//
// All grid math is done on integer year/month/day parts. We use
// `Date.UTC(y, m, d)` ONLY to derive a stable weekday index (0=Sun) — it
// is UTC-anchored so it never shifts across the viewer's local timezone,
// and we never read back a local date from it. Selected/emitted values
// stay `YYYY-MM-DD` strings, consistent with the rest of this file.

/** Weekday (0=Sun … 6=Sat) for a 1-based month, via UTC anchor. */
function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Build a `YYYY-MM-DD` ISO string from integer parts (zero-padded). */
function partsToIso(year: number, month: number, day: number): string {
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${String(year).padStart(4, "0")}-${mm}-${dd}`;
}

type DayCell = {
  year: number;
  month: number; // 1-based
  day: number;
  inMonth: boolean; // false for leading/trailing days from adjacent months
};

/**
 * 42 cells (6 rows × 7 cols) for the month grid of `year`/`month`
 * (1-based), Sunday-first, padded with the tail of the previous month and
 * the head of the next month. Pure integer math — no local-tz Date reads.
 */
export function monthGrid(year: number, month: number): DayCell[] {
  const firstWeekday = weekdayOf(year, month, 1);
  const daysThis = daysInMonth(year, month);
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  const daysPrev = daysInMonth(prevYear, prevMonth);
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;

  const cells: DayCell[] = [];
  // Leading days from the previous month.
  for (let i = firstWeekday - 1; i >= 0; i--) {
    cells.push({ year: prevYear, month: prevMonth, day: daysPrev - i, inMonth: false });
  }
  // Current-month days.
  for (let d = 1; d <= daysThis; d++) {
    cells.push({ year, month, day: d, inMonth: true });
  }
  // Trailing days from the next month to fill 42 cells.
  let nextDay = 1;
  while (cells.length < 42) {
    cells.push({ year: nextYear, month: nextMonth, day: nextDay++, inMonth: false });
  }
  return cells;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const WEEKDAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

/** Step a {year, month} by ±1 month, wrapping the year. */
function stepMonth(year: number, month: number, delta: 1 | -1): { year: number; month: number } {
  let m = month + delta;
  let y = year;
  if (m < 1) {
    m = 12;
    y -= 1;
  } else if (m > 12) {
    m = 1;
    y += 1;
  }
  return { year: y, month: m };
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

  // Ref to the visible <input> + a pending caret offset. After a change
  // commits the controlled value, a layout effect restores the caret to
  // the edit point (mapped by digit index) so deleting a digit doesn't
  // bounce the caret to the end.
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingCaret = useRef<number | null>(null);

  // The user's intended "this year" for the current-year convenience.
  // Computed once on mount via lazy init — a client Date is correct here
  // (it's the viewer's local calendar year) and is passed INTO the pure
  // helper so the helper itself never constructs a Date.
  const [currentYear] = useState(() => new Date().getFullYear());

  // Today's local calendar date as integer parts, captured once on mount
  // (viewer-local "today" for the calendar's TODAY marker + quick button).
  const [today] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
  });

  // Popover open state + the month the grid is currently showing. The
  // calendar is purely additive: typing in the visible input still works
  // exactly as before whether or not the popover is open.
  const [open, setOpen] = useState(false);
  const [viewYM, setViewYM] = useState<{ year: number; month: number }>(() => ({
    year: today.year,
    month: today.month,
  }));
  // The day cell currently focused for keyboard nav (1-based) within
  // viewYM; null until the user arrows into the grid.
  const [focusDay, setFocusDay] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  // Resolve the ISO from the current text, applying the current-year fill
  // so "MM/DD" (year left blank) still produces a valid ISO. Filling MM/DD
  // does NOT mutate the visible text here — that happens on blur.
  const iso = maskedToIso(fillCurrentYear(text, currentYear));

  if (controlled) {
    const incomingIso = value ?? "";
    if (iso !== incomingIso) {
      const masked = isoToMasked(incomingIso);
      // Only adopt the parent value when it represents a different date
      // than what's typed; this avoids clobbering mid-typing partials
      // that haven't resolved to a valid ISO yet.
      if (masked !== text && incomingIso !== "") {
        setText(masked);
      } else if (incomingIso === "" && iso !== "") {
        // Parent cleared a previously-resolved value → clear our text too.
        setText("");
      }
    }
  }

  // Restore the caret to the pending edit point after the value commits.
  useLayoutEffect(() => {
    if (pendingCaret.current === null) return;
    const el = inputRef.current;
    if (el) {
      const pos = Math.max(0, Math.min(pendingCaret.current, el.value.length));
      el.setSelectionRange(pos, pos);
    }
    pendingCaret.current = null;
  });

  function commit(masked: string, caret: number) {
    pendingCaret.current = caret;
    setText(masked);
    if (onChange) onChange(maskedToIso(fillCurrentYear(masked, currentYear)));
  }

  // Commit a fully-resolved ISO `YYYY-MM-DD` from the calendar. Routes
  // through the SAME path as typing: the masked visible text, the hidden
  // ISO (derived from `text`), and `onChange` all update together.
  function commitIso(isoValue: string) {
    const masked = isoToMasked(isoValue);
    // No caret to restore — the calendar, not the text field, drove this.
    pendingCaret.current = null;
    setText(masked);
    if (onChange) onChange(isoValue);
  }

  // When the popover opens, point the visible month at the selected date
  // (if any) so the user lands on the right month.
  function openCalendar() {
    if (disabled) return;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (m) {
      setViewYM({ year: Number(m[1]), month: Number(m[2]) });
      setFocusDay(Number(m[3]));
    } else {
      setViewYM({ year: today.year, month: today.month });
      setFocusDay(null);
    }
    setOpen(true);
  }

  function selectCell(cell: DayCell) {
    commitIso(partsToIso(cell.year, cell.month, cell.day));
    setOpen(false);
    // Return focus to the field for a smooth typing-first flow.
    inputRef.current?.focus();
  }

  // Close on click-outside + Escape while the popover is open.
  useEffect(() => {
    if (!open) return;
    const onDocPointer = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onDocKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        inputRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDocPointer);
    document.addEventListener("keydown", onDocKey);
    // Focus the grid so arrow-key navigation works immediately on open.
    gridRef.current?.focus();
    return () => {
      document.removeEventListener("mousedown", onDocPointer);
      document.removeEventListener("keydown", onDocKey);
    };
  }, [open]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const el = e.target;
    const rawCaret = el.selectionStart ?? el.value.length;
    // Digit index at the caret in the user's raw (pre-mask) value, then
    // re-mask and place the caret after that same number of digits — so
    // slashes the mask re-inserts never push the caret off the edit point.
    const digitIndex = caretToDigitIndex(el.value, rawCaret);
    const masked = maskDigits(el.value);
    const caret = digitIndexToCaret(masked, digitIndex);
    commit(masked, caret);
  };

  // Backspace/Delete operate on the DIGIT model so the structural slashes
  // can't be deleted or stranded. When the caret is at a slash boundary,
  // backspace removes the preceding digit and delete removes the next one;
  // the caret then lands at the edit point (before the digit that shifts
  // into the freed slot).
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const el = e.currentTarget;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? start;
    if (e.key !== "Backspace" && e.key !== "Delete") return;
    // Let the browser handle range selections natively, then our onChange
    // re-masks and re-maps the caret by digit index.
    if (start !== end) return;

    const digits = el.value.replace(/\D/g, "");
    const caretDigits = caretToDigitIndex(el.value, start);

    let removeIndex: number;
    if (e.key === "Backspace") {
      // Delete the digit before the caret (skipping any slash).
      removeIndex = caretDigits - 1;
    } else {
      // Delete the digit at/after the caret (skipping any slash).
      removeIndex = caretDigits;
    }
    if (removeIndex < 0 || removeIndex >= digits.length) {
      // Nothing to delete (e.g. backspace at start) — prevent the default
      // so a lone slash can never be removed, leave value unchanged.
      e.preventDefault();
      return;
    }

    e.preventDefault();
    const nextDigits = digits.slice(0, removeIndex) + digits.slice(removeIndex + 1);
    const masked = maskDigits(nextDigits);
    const caret = digitIndexToCaret(masked, removeIndex);
    commit(masked, caret);
  };

  // On blur, fill the current year if the user entered only MM/DD so the
  // visible field shows the full date and the hidden ISO resolves.
  const handleBlur = () => {
    const filled = fillCurrentYear(text, currentYear);
    if (filled !== text) {
      // No caret restore needed on blur (field is losing focus).
      pendingCaret.current = null;
      setText(filled);
      if (onChange) onChange(maskedToIso(filled));
    }
  };

  // Grid + keyboard nav for the open popover.
  const grid = monthGrid(viewYM.year, viewYM.month);
  const selected = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const selYear = selected ? Number(selected[1]) : null;
  const selMonth = selected ? Number(selected[2]) : null;
  const selDay = selected ? Number(selected[3]) : null;

  // Move the keyboard focus within the grid by a day delta, crossing into
  // adjacent months (and re-pointing the view) as needed.
  function moveFocus(delta: number) {
    const base = focusDay ?? selDay ?? today.day;
    let { year, month } = viewYM;
    let day = base + delta;
    // Walk across month boundaries via pure day-count arithmetic.
    while (day < 1) {
      const prev = stepMonth(year, month, -1);
      year = prev.year;
      month = prev.month;
      day += daysInMonth(year, month);
    }
    let len = daysInMonth(year, month);
    while (day > len) {
      day -= len;
      const next = stepMonth(year, month, 1);
      year = next.year;
      month = next.month;
      len = daysInMonth(year, month);
    }
    setViewYM({ year, month });
    setFocusDay(day);
  }

  function handleGridKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault();
        moveFocus(-1);
        break;
      case "ArrowRight":
        e.preventDefault();
        moveFocus(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveFocus(-7);
        break;
      case "ArrowDown":
        e.preventDefault();
        moveFocus(7);
        break;
      case "Enter":
      case " ": {
        e.preventDefault();
        const d = focusDay ?? selDay ?? today.day;
        selectCell({ year: viewYM.year, month: viewYM.month, day: d, inMonth: true });
        break;
      }
      default:
        break;
    }
  }

  return (
    <div ref={wrapRef} className="relative">
      <input
        ref={inputRef}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder="MM/DD/YYYY"
        maxLength={10}
        value={text}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
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
        // Reserve room on the right for the calendar adornment so long
        // text never slides under it.
        className={(className ?? BASE_STYLES) + " pr-10"}
      />

      {/* Trailing calendar toggle (inside the field, right edge). */}
      <button
        type="button"
        tabIndex={-1}
        disabled={disabled}
        aria-label="Open calendar"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openCalendar())}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-lg text-fg-subtle transition-colors hover:text-fg disabled:cursor-not-allowed disabled:text-fg-disabled"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <path d="M16 2v4M8 2v4M3 10h18" />
        </svg>
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Choose date"
          className="absolute left-0 top-full z-50 mt-2 w-[19rem] max-w-[calc(100vw-1rem)] rounded-xl border border-line bg-surface p-3 shadow-lg"
        >
          {/* Header: prev ‹ — Month Year — › next */}
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              aria-label="Previous month"
              onClick={() => setViewYM((s) => stepMonth(s.year, s.month, -1))}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
            >
              <span aria-hidden="true" className="text-lg leading-none">
                &#8249;
              </span>
            </button>
            <div className="text-sm font-semibold text-fg">
              {MONTH_NAMES[viewYM.month - 1]} {viewYM.year}
            </div>
            <button
              type="button"
              aria-label="Next month"
              onClick={() => setViewYM((s) => stepMonth(s.year, s.month, 1))}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
            >
              <span aria-hidden="true" className="text-lg leading-none">
                &#8250;
              </span>
            </button>
          </div>

          {/* Weekday column headers */}
          <div className="grid grid-cols-7 gap-1">
            {WEEKDAY_LABELS.map((w) => (
              <div
                key={w}
                className="flex h-7 items-center justify-center text-xs font-medium text-fg-subtle"
              >
                {w}
              </div>
            ))}
          </div>

          {/* 6-row day grid (keyboard-navigable as a group) */}
          <div
            ref={gridRef}
            className="mt-1 grid grid-cols-7 gap-1 outline-none"
            role="grid"
            tabIndex={0}
            onKeyDown={handleGridKeyDown}
          >
            {grid.map((cell) => {
              const isSelected =
                cell.year === selYear && cell.month === selMonth && cell.day === selDay;
              const isToday =
                cell.year === today.year &&
                cell.month === today.month &&
                cell.day === today.day;
              const isFocus =
                cell.inMonth && focusDay !== null && cell.day === focusDay;
              return (
                <button
                  type="button"
                  key={`${cell.year}-${cell.month}-${cell.day}-${cell.inMonth ? "in" : "out"}`}
                  aria-current={isToday ? "date" : undefined}
                  aria-pressed={isSelected}
                  onClick={() => selectCell(cell)}
                  className={
                    "flex h-9 w-9 items-center justify-center rounded-lg text-sm transition-colors " +
                    (isSelected
                      ? "bg-gold font-semibold text-gold-ink hover:bg-gold-hover"
                      : cell.inMonth
                        ? "text-fg hover:bg-surface-2"
                        : "text-fg-disabled hover:bg-surface-2") +
                    (isToday && !isSelected ? " ring-1 ring-inset ring-gold" : "") +
                    (isFocus && !isSelected ? " bg-surface-2" : "")
                  }
                >
                  {cell.day}
                </button>
              );
            })}
          </div>

          {/* Footer: Today quick button */}
          <div className="mt-3 flex items-center justify-between border-t border-line pt-2">
            <button
              type="button"
              onClick={() => selectCell({ ...today, inMonth: true })}
              className="rounded-lg px-2 py-1 text-xs font-medium text-gold-strong transition-colors hover:bg-surface-2"
            >
              Today
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                inputRef.current?.focus();
              }}
              className="rounded-lg px-2 py-1 text-xs font-medium text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg"
            >
              Close
            </button>
          </div>
        </div>
      ) : null}

      {name ? <input type="hidden" name={name} value={iso} /> : null}
    </div>
  );
}
