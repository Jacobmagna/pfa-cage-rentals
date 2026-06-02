// Filter form above the sessions table. Native method=GET form so
// the URL is the source of truth — refresh, deep-link, browser-back
// all just work. Server re-renders with the filtered query result.
//
// Coach / Resource / Use type use the shared MultiSelect popover so
// the page scales past a few coaches without growing a checkbox
// thicket (see /admin/reports for the older inline-checkbox style).
// Date range stays as two <input type="date"> inputs because a date
// range isn't really multi-select — it's two endpoints.
//
// "No filter" semantics: a MultiSelect with nothing checked renders
// no hidden inputs, so the URL omits that param, which the page
// reads as "all". A cleared from/to also falls back to the default
// 14-day window (handled in the page).

import { Search, X } from "lucide-react";
import Link from "next/link";
import { MultiSelect } from "@/app/_components/multi-select";

type CoachOption = {
  id: string;
  name: string | null;
  email: string;
};

type ResourceOption = {
  id: string;
  name: string;
  type: "cage" | "bullpen" | "weight_room";
};

type FilterValues = {
  from: string;
  to: string;
  coachIds: string[];
  resourceIds: string[];
  useTypes: ("hitting" | "pitching")[];
  teamRental: ("yes" | "no")[];
  pfaReferred: ("yes" | "no")[];
};

export function FiltersForm({
  coaches,
  resources,
  values,
  isFiltered,
}: {
  coaches: CoachOption[];
  resources: ResourceOption[];
  values: FilterValues;
  isFiltered: boolean;
}) {
  const coachOptions = coaches.map((c) => ({
    value: c.id,
    label: c.name ?? c.email,
  }));
  const resourceOptions = resources.map((r) => ({
    value: r.id,
    label: r.name,
  }));
  const useTypeOptions = [
    { value: "hitting", label: "Hitting" },
    { value: "pitching", label: "Pitching" },
  ];
  const teamRentalOptions = [
    { value: "yes", label: "Team rentals only" },
    { value: "no", label: "Private lessons only" },
  ];
  const pfaReferredOptions = [
    { value: "yes", label: "PFA-referred only" },
    { value: "no", label: "Coach-sourced only" },
  ];

  return (
    <form
      method="GET"
      action="/admin/sessions"
      className="rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)] p-5 mb-6"
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-7 lg:items-end">
        <Field label="From">
          <input
            type="date"
            name="from"
            defaultValue={values.from}
            className={inputStyles}
          />
        </Field>
        <Field label="To">
          <input
            type="date"
            name="to"
            defaultValue={values.to}
            className={inputStyles}
          />
        </Field>

        <Field label="Coach">
          <MultiSelect
            name="coachIds"
            options={coachOptions}
            defaultSelected={values.coachIds}
            placeholder="All coaches"
            searchPlaceholder="Search coaches…"
            aria-label="Filter by coach"
          />
        </Field>

        <Field label="Resource">
          <MultiSelect
            name="resourceIds"
            options={resourceOptions}
            defaultSelected={values.resourceIds}
            placeholder="All resources"
            searchPlaceholder="Search resources…"
            aria-label="Filter by resource"
          />
        </Field>

        <Field label="Use type">
          <MultiSelect
            name="useTypes"
            options={useTypeOptions}
            defaultSelected={values.useTypes}
            placeholder="All uses"
            aria-label="Filter by use type"
          />
        </Field>

        <Field label="Team rental">
          <MultiSelect
            name="teamRental"
            options={teamRentalOptions}
            defaultSelected={values.teamRental}
            placeholder="All bookings"
            aria-label="Filter by team rental"
          />
        </Field>

        <Field label="PFA-referred">
          <MultiSelect
            name="pfaReferred"
            options={pfaReferredOptions}
            defaultSelected={values.pfaReferred}
            placeholder="All sources"
            aria-label="Filter by PFA-referred"
          />
        </Field>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="submit"
          className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-gold px-5 h-10 text-sm font-medium text-gold-ink hover:bg-gold-hover shadow-[var(--shadow-sm)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
        >
          <Search className="h-4 w-4" strokeWidth={2.5} />
          Apply filters
        </button>

        {isFiltered ? (
          <Link
            href="/admin/sessions"
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
      <span className="text-xs uppercase tracking-wider text-fg-muted block mb-1.5">
        {label}
      </span>
      {children}
    </div>
  );
}

const inputStyles =
  "w-full rounded-lg bg-surface border border-line text-fg placeholder:text-fg-subtle px-3 h-10 text-sm focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40";
