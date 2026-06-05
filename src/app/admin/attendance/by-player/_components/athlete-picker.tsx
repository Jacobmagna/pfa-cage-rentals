"use client";

// Athlete picker for the admin Attendance "By player" view (QA10 W2.3).
// Native method=GET form so the URL (?athleteId=) is the source of
// truth — refresh, deep-link, browser-back all just work, and the
// server re-renders with the chosen athlete's attendance. Mirrors the
// by-program ProgramPicker, swapping program → athlete and showing each
// option as "Last, First".
//
// Changing the select auto-submits (onChange → form.requestSubmit) so
// the admin doesn't hunt for a button, but an explicit "View" submit is
// kept for accessibility / no-JS.

import { useRef } from "react";
import { ChevronDown } from "lucide-react";

export type AthleteOption = {
  id: string;
  firstName: string;
  lastName: string;
};

export function AthletePicker({
  athletes,
  selectedAthleteId,
}: {
  athletes: AthleteOption[];
  selectedAthleteId: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);

  function autoSubmit() {
    formRef.current?.requestSubmit();
  }

  return (
    <form
      ref={formRef}
      method="GET"
      action="/admin/attendance/by-player"
      className="rounded-xl border border-line bg-surface p-5 shadow-[var(--shadow-sm)]"
    >
      <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
        <div className="block">
          <span className="text-xs uppercase tracking-wider text-fg-muted block mb-1.5">
            Player
          </span>
          <div className="relative">
            <select
              name="athleteId"
              defaultValue={selectedAthleteId}
              aria-label="Player"
              onChange={autoSubmit}
              className={`${inputStyles} appearance-none pr-8`}
            >
              <option value="">Choose a player…</option>
              {athletes.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.lastName}, {a.firstName}
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
          className="inline-flex items-center justify-center rounded-md bg-gold px-5 h-10 text-sm font-medium text-gold-ink shadow-[var(--shadow-sm)] hover:bg-gold-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
        >
          View
        </button>
      </div>
    </form>
  );
}

const inputStyles =
  "w-full rounded-md bg-page border border-line text-fg placeholder:text-fg-subtle px-3 h-10 text-sm focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40";
