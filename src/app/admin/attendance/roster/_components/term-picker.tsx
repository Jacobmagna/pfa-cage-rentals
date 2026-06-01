"use client";

// Term picker for the add / edit athlete forms (DEC-28). Two <select>s
// — season + year — that the form-action composes into the normalized
// "Season YYYY" string. Optional: leaving both blank persists term =
// null; the "exactly one set" case is rejected by the form-action.
// Styled to match the existing form inputs/selects.

export const SEASONS = ["Spring", "Summer", "Fall", "Winter"] as const;

// currentYear-1 … currentYear+2, computed at render so the range
// rolls forward over time without a redeploy.
function yearOptions(): number[] {
  const current = new Date().getFullYear();
  const years: number[] = [];
  for (let y = current - 1; y <= current + 2; y += 1) years.push(y);
  return years;
}

// Split a stored term ("Summer 2026") back into its season + year so the
// edit form can prefill the pickers. Returns blanks when the value
// doesn't match "<Season> <4-digit-year>".
export function parseTerm(term: string | null): {
  season: string;
  year: string;
} {
  if (!term) return { season: "", year: "" };
  const idx = term.lastIndexOf(" ");
  if (idx <= 0) return { season: "", year: "" };
  const season = term.slice(0, idx);
  const year = term.slice(idx + 1);
  if (
    !(SEASONS as readonly string[]).includes(season) ||
    !/^\d{4}$/.test(year)
  ) {
    return { season: "", year: "" };
  }
  return { season, year };
}

export function TermPicker({
  defaultSeason = "",
  defaultYear = "",
}: {
  defaultSeason?: string;
  defaultYear?: string;
}) {
  const years = yearOptions();

  return (
    <label className="block">
      <span className="mb-1.5 flex items-baseline justify-between">
        <span className="text-xs uppercase tracking-wider text-fg-muted">
          Term
        </span>
        <span className="text-[10px] text-fg-subtle">optional</span>
      </span>
      <div className="grid grid-cols-2 gap-2">
        <select
          name="season"
          defaultValue={defaultSeason}
          aria-label="Season"
          className={inputStyles}
        >
          <option value="">Season…</option>
          {SEASONS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          name="year"
          defaultValue={defaultYear}
          aria-label="Year"
          className={inputStyles}
        >
          <option value="">Year…</option>
          {years.map((y) => (
            <option key={y} value={String(y)}>
              {y}
            </option>
          ))}
        </select>
      </div>
    </label>
  );
}

const inputStyles =
  "w-full rounded-md bg-page border border-line text-fg placeholder:text-fg-subtle px-3 h-10 text-sm focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40";
