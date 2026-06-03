"use client";

// Program + date picker for the attendance page. Native method=GET form
// so the URL (?programId=&date=) is the source of truth — refresh,
// deep-link, browser-back all just work, and the server re-renders with
// the chosen program's roster. Mirrors the admin hour-log filters-form
// GET pattern (no client router).
//
// Changing either control auto-submits (onChange → form.requestSubmit)
// so the coach doesn't have to hunt for a button, but an explicit "Load"
// submit is kept for accessibility / no-JS.

import { useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { DateInput } from "@/app/_components/date-input";

export type ProgramOption = {
  id: string;
  name: string;
};

export function ProgramDatePicker({
  programs,
  selectedProgramId,
  date,
}: {
  programs: ProgramOption[];
  selectedProgramId: string;
  date: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [dateIso, setDateIso] = useState(date);

  function autoSubmit() {
    formRef.current?.requestSubmit();
  }

  // The date field is typable now, so we auto-submit only once it
  // resolves to a complete valid date (or is cleared) rather than on
  // every keystroke — preserving the "change the control → reload the
  // roster" UX without firing a GET mid-typing.
  function handleDateChange(iso: string) {
    setDateIso(iso);
    if (iso !== "" && iso !== date) {
      autoSubmit();
    }
  }

  return (
    <form
      ref={formRef}
      method="GET"
      action="/coach/attendance"
      className="rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)] p-5"
    >
      <div className="grid gap-4 sm:grid-cols-[1fr_auto_auto] sm:items-end">
        <Field label="Program">
          <div className="relative">
            <select
              name="programId"
              defaultValue={selectedProgramId}
              aria-label="Program"
              onChange={autoSubmit}
              className={`${inputStyles} appearance-none pr-8`}
            >
              <option value="">Choose a program…</option>
              {programs.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <ChevronDown
              aria-hidden
              className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-fg-subtle"
            />
          </div>
        </Field>

        <Field label="Date">
          <DateInput
            name="date"
            value={dateIso}
            aria-label="Date"
            onChange={handleDateChange}
            className={inputStyles}
          />
        </Field>

        <button
          type="submit"
          className="inline-flex items-center justify-center rounded-lg bg-gold shadow-[var(--shadow-sm)] px-5 h-10 text-sm font-medium text-gold-ink hover:bg-gold-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
        >
          Load
        </button>
      </div>
    </form>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="block">
      <span className="text-xs uppercase tracking-wider text-fg-muted block mb-1.5">
        {label}
      </span>
      {children}
    </div>
  );
}

const inputStyles =
  "w-full rounded-lg bg-surface border border-line text-fg placeholder:text-fg-subtle px-3 h-10 text-sm focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40";
