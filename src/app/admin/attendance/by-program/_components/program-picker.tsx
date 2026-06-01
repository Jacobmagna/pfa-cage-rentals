"use client";

// Program picker for the admin Attendance-by-Program grid (FEAT-10).
// Native method=GET form so the URL (?programId=) is the source of
// truth — refresh, deep-link, browser-back all just work, and the
// server re-renders with the chosen program's grid. Mirrors the coach
// attendance ProgramDatePicker, minus the date field (the admin grid
// shows ALL of a program's sessions, not one day).
//
// Changing the select auto-submits (onChange → form.requestSubmit) so
// the admin doesn't hunt for a button, but an explicit "View" submit is
// kept for accessibility / no-JS.

import { useRef } from "react";
import { ChevronDown } from "lucide-react";

export type ProgramOption = {
  id: string;
  name: string;
};

export function ProgramPicker({
  programs,
  selectedProgramId,
}: {
  programs: ProgramOption[];
  selectedProgramId: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);

  function autoSubmit() {
    formRef.current?.requestSubmit();
  }

  return (
    <form
      ref={formRef}
      method="GET"
      action="/admin/attendance/by-program"
      className="rounded-lg border border-line bg-surface p-5"
    >
      <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
        <div className="block">
          <span className="text-xs uppercase tracking-wider text-fg-muted block mb-1.5">
            Program
          </span>
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
        </div>

        <button
          type="submit"
          className="inline-flex items-center justify-center rounded-md bg-gold px-5 h-10 text-sm font-medium text-gold-ink hover:bg-gold-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
        >
          View
        </button>
      </div>
    </form>
  );
}

const inputStyles =
  "w-full rounded-md bg-page border border-line text-fg placeholder:text-fg-subtle px-3 h-10 text-sm focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40";
