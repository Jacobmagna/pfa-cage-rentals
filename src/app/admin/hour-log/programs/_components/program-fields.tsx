"use client";

// Shared form fields for create + edit program forms: name + how the program
// pays. The program-level session cap was removed — the cap is now a
// PER-ATHLETE enrollment cap set on the Roster assign flow, so the
// create/edit form no longer carries cap/capPeriod.
//
// 0052 — PAY MODE. A program pays either BY TIME (per-hour rate, the
// original and still the default) or PER SESSION (a flat fee for each logged
// session, regardless of how long it ran). Per-session previously existed
// only as a per-coach override, which is why a flat per-GAME fee had to be
// faked as an hourly rate — and then paid by game length.

import { useState } from "react";

export type ProgramFieldDefaults = {
  name: string;
  /** Pay rate per HOUR, as dollars (e.g. "44.00"). "" = no rate. */
  rateDollars: string;
  /** How this program pays. Defaults to time-based. */
  payMode: "hourly" | "per_session";
  /** Flat pay per logged session, as dollars (e.g. "100.00"). "" = not set. */
  perSessionDollars: string;
};

export function ProgramFields({
  defaults,
}: {
  defaults: ProgramFieldDefaults;
}) {
  const [payMode, setPayMode] = useState<"hourly" | "per_session">(
    defaults.payMode,
  );
  const perSession = payMode === "per_session";

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

      <Field label="How this program pays">
        {/* The submitted value: a hidden input tracks the toggle so the form
            posts payMode without needing a native select. */}
        <input type="hidden" name="payMode" value={payMode} />
        <div className="flex gap-2" role="group" aria-label="How this program pays">
          <ModeButton
            active={!perSession}
            onClick={() => setPayMode("hourly")}
            label="Pay by time"
            title="By time"
            hint="Paid per hour logged"
          />
          <ModeButton
            active={perSession}
            onClick={() => setPayMode("per_session")}
            label="Pay per session"
            title="Per session"
            hint="Flat fee each time it's logged"
          />
        </div>
      </Field>

      {perSession ? (
        <>
          <Field label="Pay per session">
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-fg-subtle">
                $
              </span>
              <input
                type="text"
                inputMode="decimal"
                name="perSessionDollars"
                required
                defaultValue={defaults.perSessionDollars}
                placeholder="e.g. 100.00"
                aria-label="Pay per session"
                className={`${inputStyles} pl-7`}
              />
            </div>
          </Field>
          <p className="rounded-md border border-line bg-surface-2 px-3 py-2 text-xs text-fg-muted">
            Each logged session pays this flat amount, no matter how long it
            ran — a 2-hour game and a 4-hour game both pay the same.
            <br />
            <span className="text-fg">
              Heads up: a coach with their own rate set for this program keeps
              that rate. Clear their override to put them on the flat fee.
            </span>
          </p>
        </>
      ) : (
        <Field label="Pay rate (per hour)">
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-fg-subtle">
              $
            </span>
            <input
              type="text"
              inputMode="decimal"
              name="rateDollars"
              defaultValue={defaults.rateDollars}
              placeholder="Optional — e.g. 44.00"
              aria-label="Pay rate per hour"
              className={`${inputStyles} pl-7`}
            />
          </div>
        </Field>
      )}
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  label,
  title,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  /**
   * The accessible name. Without it the name is the raw concatenation of the
   * title and hint spans ("By timePaid per hour logged"), which reads badly in
   * a screen reader and is unstable to target.
   */
  label: string;
  title: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      className={`flex-1 rounded-md border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 ${
        active
          ? "border-gold bg-gold/10 text-fg"
          : "border-line bg-page text-fg-muted hover:border-line-strong hover:text-fg"
      }`}
    >
      <span className="block text-sm font-medium">{title}</span>
      <span className="mt-0.5 block text-xs text-fg-muted">{hint}</span>
    </button>
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
