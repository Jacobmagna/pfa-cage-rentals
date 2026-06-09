"use client";

// Roster filter bar (DEC-28). Native method=GET form so the URL
// (?term= and ?program=) is the source of truth — refresh, deep-link and
// browser-back all just work, and the server re-renders the roster
// filtered to the chosen term/program. Both selects live in ONE form so
// every auto-submit preserves both params. Mirrors the by-program
// ProgramPicker.
//
// Changing either select auto-submits; an explicit "Apply" button is kept
// for accessibility / no-JS.

import { useRef } from "react";
import { ChevronDown } from "lucide-react";

export function TermFilter({
  terms,
  selectedTerm,
  programs,
  selectedProgram,
}: {
  terms: string[];
  selectedTerm: string;
  programs: { id: string; name: string }[];
  selectedProgram: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);

  function autoSubmit() {
    formRef.current?.requestSubmit();
  }

  return (
    <form
      ref={formRef}
      method="GET"
      action="/admin/attendance/roster"
      className="flex flex-wrap items-end gap-3"
    >
      {terms.length > 0 ? (
        <label className="block">
          <span className="text-xs uppercase tracking-wider text-fg-muted block mb-1.5">
            Term
          </span>
          <div className="relative">
            <select
              name="term"
              defaultValue={selectedTerm}
              aria-label="Filter by term"
              onChange={autoSubmit}
              className={`${inputStyles} appearance-none pr-8`}
            >
              <option value="">All terms</option>
              {terms.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <ChevronDown
              aria-hidden
              className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-fg-subtle"
            />
          </div>
        </label>
      ) : null}

      {programs.length > 0 ? (
        <label className="block">
          <span className="text-xs uppercase tracking-wider text-fg-muted block mb-1.5">
            Work
          </span>
          <div className="relative">
            <select
              name="program"
              defaultValue={selectedProgram}
              aria-label="Filter by program"
              onChange={autoSubmit}
              className={`${inputStyles} appearance-none pr-8`}
            >
              <option value="">All work</option>
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
        </label>
      ) : null}

      <button
        type="submit"
        className="inline-flex items-center justify-center rounded-md border border-line bg-surface-2 px-4 h-10 text-sm font-medium text-fg-muted hover:border-line-strong hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
      >
        Apply
      </button>
    </form>
  );
}

const inputStyles =
  "w-full min-w-[10rem] rounded-md bg-page border border-line text-fg placeholder:text-fg-subtle px-3 h-10 text-sm focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40";
