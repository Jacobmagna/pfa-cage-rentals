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
//
// The old "Scope" checkboxes (Cage rental sessions / Work hours) are
// GONE — the sub-tabs replaced them (reports-tabs SPEC §4). That deletion
// is the fix for SPEC §1(b): the "Work hours" box was silently overridden
// whenever the resource-type filter narrowed, so it could be ticked and
// still show nothing. With tabs there is no scope box left to override.

import { Search } from "lucide-react";
import { MultiSelect } from "@/app/_components/multi-select";
import { DateInput } from "@/app/_components/date-input";
import type { ReportTab } from "@/lib/reports/tabs";

type FilterValues = {
  from: string;
  to: string;
  coachIds: string[]; // empty means "all coaches"
  resourceTypes: ("cage" | "bullpen" | "weight_room")[]; // empty means "all"
  programId: string; // "" means "all programs"
};

type CoachOption = {
  id: string;
  name: string | null;
  email: string;
};

type ProgramOption = {
  id: string;
  name: string;
};

const ALL_RESOURCE_TYPES = ["cage", "bullpen", "weight_room"] as const;
const RESOURCE_LABEL: Record<(typeof ALL_RESOURCE_TYPES)[number], string> = {
  cage: "Cages",
  bullpen: "Bullpens",
  weight_room: "Weight Room",
};

export function FiltersForm({
  coaches,
  programs,
  values,
  activeTab,
}: {
  coaches: CoachOption[];
  programs: ProgramOption[];
  values: FilterValues;
  /** Carried through the submit so applying filters stays on this tab. */
  activeTab: ReportTab;
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
      {/* A GET submit rebuilds the query string from the form's fields
          alone, so without this the tab would reset to Cage every time
          the admin pressed Apply. */}
      <input type="hidden" name="tab" value={activeTab} />
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

        {/* The two type filters are mirror images and each applies to ONE
            tab (SPEC §4). Both stay visible on every tab rather than
            appearing and disappearing — a filter bar that changes shape
            under you is its own kind of confusing — so each one says which
            tab it acts on. */}
        <Field
          label="Resource types"
          hint="Cage rentals tab only. Leave all unchecked for everything."
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

        <Field label="Program" hint="Work hours tab only.">
          {programs.length === 0 ? (
            <p className="h-10 inline-flex items-center text-xs text-fg-subtle">
              No programs yet.
            </p>
          ) : (
            <select
              name="programId"
              defaultValue={values.programId}
              aria-label="Filter by program"
              className={inputStyles}
            >
              <option value="">All programs</option>
              {programs.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
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
