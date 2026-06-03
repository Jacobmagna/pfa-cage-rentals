"use client";

import { useId } from "react";
import { Search, X } from "lucide-react";

// Reusable presentational search input for people-list surfaces
// (Roster, Coaches, Archive, Payments balances). Controlled (value +
// onChange); each surface owns its own filter state and runs the
// client-side filter via list-search.logic. No data fetching here.
//
// Renders an accessible <input type="search"> with a leading Search
// icon, the standard input styling + gold focus ring, an optional
// results-count affordance, and a clear (✕) button when non-empty.

export function ListSearch({
  value,
  onChange,
  placeholder,
  label,
  resultCount,
  totalCount,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  /** Accessible name for the input. Falls back to the placeholder. */
  label?: string;
  /** When provided, renders "<resultCount> of <totalCount>" beside the input. */
  resultCount?: number;
  totalCount?: number;
  className?: string;
}) {
  const id = useId();
  const accessibleName = label ?? placeholder;
  const showCount =
    typeof resultCount === "number" && typeof totalCount === "number";
  const trimmed = value.trim();

  return (
    <div className={`flex flex-wrap items-center gap-3 ${className ?? ""}`}>
      <div className="relative w-full max-w-xs">
        <Search
          aria-hidden
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle"
        />
        <input
          id={id}
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-label={accessibleName}
          className="w-full min-w-[10rem] rounded-md border border-line bg-page pl-9 pr-9 h-10 text-sm text-fg placeholder:text-fg-subtle focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40 [&::-webkit-search-cancel-button]:appearance-none"
        />
        {trimmed.length > 0 ? (
          <button
            type="button"
            onClick={() => onChange("")}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-md text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
      {showCount && trimmed.length > 0 ? (
        <p className="text-xs text-fg-muted tnum">
          {resultCount} of {totalCount}
        </p>
      ) : null}
    </div>
  );
}
