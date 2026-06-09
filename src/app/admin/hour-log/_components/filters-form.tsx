// Filter form above the hour-log table. Native method=GET form so the
// URL is the source of truth — refresh, deep-link, browser-back all
// just work. Server re-renders with the filtered query result.
//
// Coach + Program are single <select> dropdowns (the hour-log filter
// shape is one coach / one program, unlike the billing report's
// multi-select). Date range stays as two typable DateInput fields.
//
// "No filter" semantics: the empty-value option submits an empty
// string, which the page's normalizer reads as "all". A cleared
// from/to falls back to the default current-month window.

import { Search, X } from "lucide-react";
import Link from "next/link";
import { DateInput } from "@/app/_components/date-input";

type CoachOption = {
  id: string;
  name: string | null;
  email: string;
};

type ProgramOption = {
  id: string;
  name: string;
};

type FilterValues = {
  from: string;
  to: string;
  coachId: string;
  programId: string;
};

export function FiltersForm({
  coaches,
  programs,
  values,
  isFiltered,
}: {
  coaches: CoachOption[];
  programs: ProgramOption[];
  values: FilterValues;
  isFiltered: boolean;
}) {
  return (
    <form
      method="GET"
      action="/admin/hour-log"
      className="rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)] p-5 mb-6"
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 lg:items-end">
        <Field label="From">
          <DateInput
            name="from"
            defaultValue={values.from}
            className={inputStyles}
          />
        </Field>
        <Field label="To">
          <DateInput
            name="to"
            defaultValue={values.to}
            className={inputStyles}
          />
        </Field>

        <Field label="Coach">
          <select
            name="coachId"
            defaultValue={values.coachId}
            aria-label="Filter by coach"
            className={selectStyles}
          >
            <option value="">All coaches</option>
            {coaches.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name ?? c.email}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Work">
          <select
            name="programId"
            defaultValue={values.programId}
            aria-label="Filter by work"
            className={selectStyles}
          >
            <option value="">All work</option>
            {programs.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="submit"
          className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-gold px-5 h-10 text-sm font-medium text-gold-ink shadow-[var(--shadow-sm)] hover:bg-gold-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
        >
          <Search className="h-4 w-4" strokeWidth={2.5} />
          Apply filters
        </button>

        {isFiltered ? (
          <Link
            href="/admin/hour-log"
            className="inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg transition-colors"
          >
            <X className="h-3.5 w-3.5" />
            Clear filters
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
      <span className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted block mb-1.5">
        {label}
      </span>
      {children}
    </div>
  );
}

const inputStyles =
  "w-full rounded-lg bg-surface border border-line text-fg placeholder:text-fg-subtle px-3 h-10 text-sm tnum focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40";
const selectStyles = `${inputStyles} appearance-none pr-8`;
