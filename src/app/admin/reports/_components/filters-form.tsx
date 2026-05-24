// Filter form for /admin/reports. Native HTML form with method=GET,
// no client-side state — submitting just updates the URL and the
// server re-renders. Shareable, browser-back works, no JS required.
//
// Checkbox semantics for "no filter" (e.g. all coaches): when the
// URL has no `coachIds` param, we render all checkboxes checked.
// If the user submits with all unchecked, the URL omits `coachIds`
// entirely → same state as "no filter" → all coaches show. We
// surface that with helper copy.

import { Search } from "lucide-react";

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
  const coachFilterActive = values.coachIds.length > 0;
  const isCoachChecked = (id: string) =>
    !coachFilterActive || values.coachIds.includes(id);
  const isTypeChecked = (t: (typeof ALL_RESOURCE_TYPES)[number]) =>
    values.resourceTypes.length === 0 || values.resourceTypes.includes(t);

  return (
    <form
      method="GET"
      action="/admin/reports"
      className="rounded-lg border border-line bg-surface p-5 mb-6"
    >
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_2fr_auto] lg:items-end">
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

        <Field
          label="Resource types"
          hint="Leave all unchecked for everything."
        >
          <div className="flex flex-wrap gap-3">
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

        <button
          type="submit"
          className="inline-flex items-center justify-center gap-1.5 rounded-md bg-gold px-5 h-10 text-sm font-medium text-gold-ink hover:bg-gold-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
        >
          <Search className="h-4 w-4" strokeWidth={2.5} />
          Apply filters
        </button>
      </div>

      <Field
        label="Coaches"
        hint={
          coachFilterActive
            ? "Only checked coaches are included."
            : "All coaches included. Check specific ones to filter."
        }
        className="mt-5"
      >
        <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
          {coaches.length === 0 ? (
            <p className="text-xs text-fg-subtle">
              No coaches in the system yet.
            </p>
          ) : (
            coaches.map((c) => (
              <CheckboxChip
                key={c.id}
                name="coachIds"
                value={c.id}
                label={c.name ?? c.email}
                defaultChecked={isCoachChecked(c.id)}
              />
            ))
          )}
        </div>
      </Field>
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
      <span className="text-xs uppercase tracking-wider text-fg-muted block mb-1.5">
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
  "w-full rounded-md bg-page border border-line text-fg placeholder:text-fg-subtle px-3 h-10 text-sm focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40";
