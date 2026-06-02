// Filter form for /admin/reports. Native HTML form with method=GET,
// so the URL is the source of truth — refresh / deep-link / browser
// back all just work, no client-side state needed for submission.
//
// Coaches use the shared MultiSelect popover (scales past a couple
// dozen coaches without the page growing a wall of checkboxes).
// Resource types stay as inline checkbox chips because there are
// only three. "No selection" semantics: an empty MultiSelect or
// fully-checked resource-type set both serialize to "no filter" →
// the URL omits the param → the page treats it as "all".

import { Search } from "lucide-react";
import { MultiSelect } from "@/app/_components/multi-select";

type FilterValues = {
  from: string;
  to: string;
  coachIds: string[]; // empty means "all coaches"
  resourceTypes: ("cage" | "bullpen" | "weight_room")[]; // empty means "all"
};

type CoachOption = {
  id: string;
  name: string | null;
  email: string;
};

const ALL_RESOURCE_TYPES = ["cage", "bullpen", "weight_room"] as const;
const RESOURCE_LABEL: Record<(typeof ALL_RESOURCE_TYPES)[number], string> = {
  cage: "Cages",
  bullpen: "Bullpens",
  weight_room: "Weight Room",
};

export function FiltersForm({
  coaches,
  values,
}: {
  coaches: CoachOption[];
  values: FilterValues;
}) {
  const isTypeChecked = (t: (typeof ALL_RESOURCE_TYPES)[number]) =>
    values.resourceTypes.length === 0 || values.resourceTypes.includes(t);

  const coachOptions = coaches.map((c) => ({
    value: c.id,
    label: c.name ?? c.email,
  }));

  return (
    <form
      method="GET"
      action="/admin/reports"
      className="rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)] p-5 mb-6"
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 lg:items-end">
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

        <Field label="Coaches">
          {coaches.length === 0 ? (
            <p className="h-10 inline-flex items-center text-xs text-fg-subtle">
              No coaches yet.
            </p>
          ) : (
            <MultiSelect
              name="coachIds"
              options={coachOptions}
              defaultSelected={values.coachIds}
              placeholder="All coaches"
              searchPlaceholder="Search coaches…"
              aria-label="Filter by coach"
            />
          )}
        </Field>

        <Field
          label="Resource types"
          hint="Leave all unchecked for everything."
        >
          <div className="flex flex-wrap gap-3 h-10 items-center">
            {ALL_RESOURCE_TYPES.map((t) => (
              <CheckboxChip
                key={t}
                name="resourceTypes"
                value={t}
                label={RESOURCE_LABEL[t]}
                defaultChecked={isTypeChecked(t)}
              />
            ))}
          </div>
        </Field>
      </div>

      <div className="mt-4">
        <button
          type="submit"
          className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-gold px-5 h-10 text-sm font-medium text-gold-ink shadow-[var(--shadow-sm)] hover:bg-gold-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
        >
          <Search className="h-4 w-4" strokeWidth={2.5} />
          Apply filters
        </button>
      </div>
    </form>
  );
}

function Field({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`block ${className ?? ""}`}>
      <span className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted block mb-1.5">
        {label}
      </span>
      {children}
      {hint ? (
        <span className="block text-[11px] text-fg-subtle mt-1.5 leading-snug">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

function CheckboxChip({
  name,
  value,
  label,
  defaultChecked,
}: {
  name: string;
  value: string;
  label: string;
  defaultChecked: boolean;
}) {
  return (
    <label className="inline-flex items-center gap-2 cursor-pointer text-sm text-fg select-none">
      <input
        type="checkbox"
        name={name}
        value={value}
        defaultChecked={defaultChecked}
        className="h-4 w-4 rounded border-line bg-page text-gold focus-visible:ring-2 focus-visible:ring-gold/40 accent-gold"
      />
      <span>{label}</span>
    </label>
  );
}

const inputStyles =
  "w-full rounded-lg bg-surface border border-line text-fg placeholder:text-fg-subtle px-3 h-10 text-sm tnum focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40";
