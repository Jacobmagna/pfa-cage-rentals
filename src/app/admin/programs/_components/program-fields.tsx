"use client";

import { useState } from "react";

// Shared form fields for create + edit program forms: name, plus a
// "Limit sessions" checkbox that reveals a cap (positive int) + period
// (week|month) pair (DEC-03 — both-or-neither). When the checkbox is
// off the cap/period inputs are hidden and the form-action clears them.
// The checkbox name is "limit"; the form-action reads it to decide
// whether to send cap/capPeriod or null.

export type ProgramFieldDefaults = {
  name: string;
  cap: string;
  capPeriod: string;
  limit: boolean;
};

export function ProgramFields({
  defaults,
}: {
  defaults: ProgramFieldDefaults;
}) {
  const [limited, setLimited] = useState(defaults.limit);

  return (
    <div className="space-y-4">
      <Field label="Name">
        <input
          type="text"
          name="name"
          required
          maxLength={200}
          defaultValue={defaults.name}
          placeholder="e.g. Elite Hitting"
          className={inputStyles}
        />
      </Field>

      <label className="flex items-center gap-2.5 text-sm text-fg">
        <input
          type="checkbox"
          name="limit"
          checked={limited}
          onChange={(e) => setLimited(e.target.checked)}
          className="h-4 w-4 accent-gold"
        />
        <span>Limit sessions per period</span>
      </label>

      {limited ? (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Cap">
            <input
              type="number"
              name="cap"
              min={1}
              step={1}
              required
              defaultValue={defaults.cap}
              placeholder="e.g. 8"
              className={inputStyles}
            />
          </Field>
          <Field label="Per">
            <select
              name="capPeriod"
              required
              defaultValue={defaults.capPeriod || "week"}
              className={selectStyles}
            >
              <option value="week">Week</option>
              <option value="month">Month</option>
            </select>
          </Field>
        </div>
      ) : null}
    </div>
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
    <label className="block">
      <span className="mb-1.5 block text-xs uppercase tracking-wider text-fg-muted">
        {label}
      </span>
      {children}
    </label>
  );
}

export const inputStyles =
  "w-full rounded-md bg-page border border-line text-fg placeholder:text-fg-subtle px-3 h-10 text-sm focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40";
export const selectStyles = `${inputStyles} appearance-none pr-8`;
