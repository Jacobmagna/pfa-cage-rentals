// Audit-log filter form. Native HTML form with method=GET — submit
// updates the URL and the server re-renders against the new params.
// Matches the /admin/reports filter pattern (server-rendered, no
// client JS, shareable links).

import { Search } from "lucide-react";
import type {
  AuditAction,
  EntityType,
  NormalizedAuditFilters,
} from "@/lib/audit/filters";

type ActorOption = {
  id: string;
  name: string | null;
  email: string;
  role: "admin" | "coach";
};

const ALL_ENTITY_TYPES: { value: EntityType; label: string }[] = [
  { value: "session", label: "Sessions" },
  { value: "block", label: "Blocks" },
  { value: "rate_override", label: "Rate overrides" },
];

const ALL_ACTIONS: { value: AuditAction; label: string }[] = [
  { value: "create", label: "Create" },
  { value: "update", label: "Update" },
  { value: "delete", label: "Delete" },
];

export function FiltersForm({
  actors,
  values,
}: {
  actors: ActorOption[];
  values: NormalizedAuditFilters;
}) {
  return (
    <form
      method="GET"
      action="/admin/audit"
      className="rounded-lg border border-line bg-surface p-5 mb-6"
    >
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1.5fr_auto] lg:items-end">
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

        <Field label="Actor" hint="Leave blank for all users.">
          <select
            name="actorId"
            defaultValue={values.actorId ?? ""}
            className={`${inputStyles} appearance-none pr-8`}
          >
            <option value="">All actors</option>
            {actors.map((a) => (
              <option key={a.id} value={a.id}>
                {(a.name ?? a.email) + (a.role === "admin" ? " (admin)" : "")}
              </option>
            ))}
          </select>
        </Field>

        <button
          type="submit"
          className="inline-flex items-center justify-center gap-1.5 rounded-md bg-gold px-5 h-10 text-sm font-medium text-gold-ink hover:bg-gold-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
        >
          <Search className="h-4 w-4" strokeWidth={2.5} />
          Apply
        </button>
      </div>

      <div className="grid gap-5 sm:grid-cols-2 mt-5">
        <Field
          label="Entity types"
          hint="Leave all unchecked for everything."
        >
          <div className="flex flex-wrap gap-3">
            {ALL_ENTITY_TYPES.map((t) => (
              <CheckboxChip
                key={t.value}
                name="entityTypes"
                value={t.value}
                label={t.label}
                defaultChecked={
                  values.entityTypes.length === 0 ||
                  values.entityTypes.includes(t.value)
                }
              />
            ))}
          </div>
        </Field>

        <Field
          label="Actions"
          hint="Leave all unchecked for everything."
        >
          <div className="flex flex-wrap gap-3">
            {ALL_ACTIONS.map((a) => (
              <CheckboxChip
                key={a.value}
                name="actions"
                value={a.value}
                label={a.label}
                defaultChecked={
                  values.actions.length === 0 ||
                  values.actions.includes(a.value)
                }
              />
            ))}
          </div>
        </Field>
      </div>
    </form>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="block">
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
