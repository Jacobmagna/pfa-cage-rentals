"use client";

// Multi-select dropdown for filter forms. Submits via hidden
// <input name={name}> entries (one per selected value), so it
// works inside a native method=GET <form> — no client-side
// submission glue needed. The page just reads multi-value
// searchParams.
//
// Closed state shows a trigger button summarizing the selection
// ("All coaches" / "Coach Name" / "3 selected"). Open state is an
// absolutely-positioned popover with a checkbox-style list and an
// inline search input (rendered when there are more than 6
// options — below that, scanning is faster than typing).
//
// Closes on outside-click or Escape. Internal selection state is
// seeded from `defaultSelected` and persists across re-renders;
// the parent doesn't need to control it.

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";

type Option = { value: string; label: string };

type MultiSelectProps = {
  name: string;
  options: Option[];
  /** Empty array means "no filter" / all. */
  defaultSelected: string[];
  /** Shown when nothing is selected — e.g. "All coaches". */
  placeholder: string;
  /** Shown inside the search input when present — e.g. "Search coaches…". */
  searchPlaceholder?: string;
  className?: string;
  "aria-label"?: string;
};

export function MultiSelect({
  name,
  options,
  defaultSelected,
  placeholder,
  searchPlaceholder,
  className,
  "aria-label": ariaLabel,
}: MultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(defaultSelected),
  );
  const [search, setSearch] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const filtered = search.trim()
    ? options.filter((o) =>
        o.label.toLowerCase().includes(search.trim().toLowerCase()),
      )
    : options;

  const toggle = (value: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  };

  const clear = () => setSelected(new Set());

  const summary =
    selected.size === 0
      ? placeholder
      : selected.size === 1
        ? (options.find((o) => o.value === [...selected][0])?.label ??
          placeholder)
        : `${selected.size} selected`;

  const showSearch = options.length > 6;

  return (
    <div ref={rootRef} className={`relative ${className ?? ""}`}>
      {[...selected].map((value) => (
        <input key={value} type="hidden" name={name} value={value} />
      ))}

      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        className="w-full inline-flex items-center justify-between gap-2 rounded-lg bg-surface border border-line text-fg px-3 h-10 text-sm hover:border-line-strong focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40 transition-colors"
      >
        <span
          className={`truncate ${
            selected.size === 0 ? "text-fg-muted" : "text-fg"
          }`}
        >
          {summary}
        </span>
        <ChevronDown
          className={`h-4 w-4 text-fg-muted shrink-0 transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open ? (
        <div className="absolute z-50 mt-1 w-full min-w-[240px] rounded-lg border border-line bg-surface shadow-[var(--shadow-lg)] overflow-hidden">
          {showSearch ? (
            <div className="border-b border-line p-2">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-fg-subtle pointer-events-none" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={searchPlaceholder ?? "Search…"}
                  className="w-full rounded-lg bg-surface-2 border border-line text-fg px-7 h-8 text-xs focus:outline-none focus:border-line-strong"
                  autoFocus
                />
              </div>
            </div>
          ) : null}

          <div className="max-h-64 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <p className="px-3 py-2 text-xs text-fg-subtle">No matches</p>
            ) : (
              filtered.map((o) => {
                const checked = selected.has(o.value);
                return (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => toggle(o.value)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-fg hover:bg-surface-2 text-left transition-colors"
                  >
                    <span
                      className={`flex h-4 w-4 items-center justify-center rounded border shrink-0 ${
                        checked
                          ? "border-gold bg-gold text-gold-ink"
                          : "border-line bg-surface-2"
                      }`}
                      aria-hidden="true"
                    >
                      {checked ? (
                        <Check className="h-3 w-3" strokeWidth={3} />
                      ) : null}
                    </span>
                    <span className="flex-1 truncate">{o.label}</span>
                  </button>
                );
              })
            )}
          </div>

          {selected.size > 0 ? (
            <div className="border-t border-line px-2 py-1.5 flex items-center justify-between">
              <span className="text-[11px] text-fg-subtle">
                {selected.size} selected
              </span>
              <button
                type="button"
                onClick={clear}
                className="inline-flex items-center gap-1 text-[11px] text-fg-muted hover:text-fg transition-colors"
              >
                <X className="h-3 w-3" />
                Clear
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
