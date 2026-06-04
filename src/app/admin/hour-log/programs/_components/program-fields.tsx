"use client";

// Shared form fields for create + edit program forms: name + an optional
// per-30-min pay rate. The program-level session cap was removed — the
// cap is now a PER-ATHLETE enrollment cap set on the Roster assign flow,
// so the create/edit form no longer carries cap/capPeriod.

export type ProgramFieldDefaults = {
  name: string;
  /** Pay rate per 30 min, as dollars (e.g. "22.00"). "" = no rate. */
  rateDollars: string;
};

export function ProgramFields({
  defaults,
}: {
  defaults: ProgramFieldDefaults;
}) {
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

      <Field label="Pay rate (per 30 min)">
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-fg-subtle">
            $
          </span>
          <input
            type="text"
            inputMode="decimal"
            name="rateDollars"
            defaultValue={defaults.rateDollars}
            placeholder="Optional — e.g. 22.00"
            aria-label="Pay rate per 30 minutes"
            className={`${inputStyles} pl-7`}
          />
        </div>
      </Field>
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
