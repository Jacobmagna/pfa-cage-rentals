// Filter bar above the coach "My sessions" history. Native method=GET form
// so the URL is the source of truth — refresh, deep-link, browser-back all
// just work, and the server re-runs BOTH the count and rows queries against
// the filtered set. Submitting omits `page`, so a filter change naturally
// lands on page 1.
//
// From/To reuse the shared masked DateInput (digits → MM/DD/YYYY, hidden ISO).
// Resource is a plain <select> (a coach picks at most one — no multi-select
// needed at this surface). "Clear" links back to the bare route, dropping
// every param.

import { Search, X } from "lucide-react";
import Link from "next/link";
import { DateInput } from "@/app/_components/date-input";
import type { ResourceOption } from "./types";

type HistoryFilterValues = {
  from: string | null;
  to: string | null;
  resourceId: string | null;
};

export function HistoryFilters({
  resources,
  values,
  isFiltered,
}: {
  resources: ResourceOption[];
  values: HistoryFilterValues;
  isFiltered: boolean;
}) {
  return (
    <form
      method="GET"
      action="/coach/sessions"
      className="rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)] p-4 mb-5"
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 lg:items-end">
        <Field label="From">
          <DateInput
            name="from"
            defaultValue={values.from ?? ""}
            className={inputStyles}
            aria-label="Filter from date"
          />
        </Field>
        <Field label="To">
          <DateInput
            name="to"
            defaultValue={values.to ?? ""}
            className={inputStyles}
            aria-label="Filter to date"
          />
        </Field>

        <Field label="Resource">
          <select
            name="resourceId"
            defaultValue={values.resourceId ?? ""}
            className={inputStyles}
            aria-label="Filter by resource"
          >
            <option value="">All resources</option>
            {resources.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="mt-3.5 flex flex-wrap items-center gap-3">
        <button
          type="submit"
          className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-gold px-5 h-10 text-sm font-medium text-gold-ink hover:bg-gold-hover shadow-[var(--shadow-sm)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
        >
          <Search className="h-4 w-4" strokeWidth={2.5} />
          Apply
        </button>

        {isFiltered ? (
          <Link
            href="/coach/sessions"
            className="inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg transition-colors"
          >
            <X className="h-3.5 w-3.5" />
            Clear
          </Link>
        ) : null}
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
