"use client";

import { useActionState, useMemo } from "react";
import { CheckCircle2, UserPlus } from "lucide-react";
import {
  addAthleteFormAction,
  type AddAthleteResult,
} from "../form-actions";
import { DateInput } from "@/app/_components/date-input";
import { TermPicker } from "./term-picker";

const INITIAL_STATE: AddAthleteResult = { ok: true, addedAt: 0 };

// Add-individual-athlete form. useActionState handles the submit; on
// success it returns an `addedAt` nonce we use as the form's remount key
// → the fields reset, ready for the next athlete. On failure the errored
// values echo back. Mirrors the cage / hour-log log forms.
export function AddAthleteForm() {
  const [state, formAction, pending] = useActionState(
    addAthleteFormAction,
    INITIAL_STATE,
  );

  const defaults = useMemo(() => {
    if (!state.ok) return state.values;
    return { firstName: "", lastName: "", birthday: "", season: "", year: "" };
  }, [state]);

  const showSuccess = state.ok && state.addedAt > 0;
  const formKey = state.ok
    ? state.addedAt > 0
      ? `ok-${state.addedAt}`
      : "fresh"
    : `err-${state.error.code}-${state.error.message}`;

  return (
    <section className="rounded-xl border border-line bg-surface p-5 shadow-[var(--shadow-sm)]">
      <div className="mb-4 flex items-center gap-2">
        <UserPlus className="h-4 w-4 text-gold" aria-hidden="true" />
        <h2 className="text-sm font-semibold tracking-tight text-fg">
          Add athlete
        </h2>
      </div>

      {showSuccess ? (
        <div
          role="status"
          className="mb-4 flex items-center gap-2 rounded-md border border-success/30 bg-success/10 px-3 py-2.5 text-sm text-success"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>Athlete added.</span>
        </div>
      ) : null}

      {!state.ok ? (
        <div
          role="alert"
          className="mb-4 rounded-md border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger"
        >
          {state.error.message}
        </div>
      ) : null}

      <form
        action={formAction}
        key={formKey}
        className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_1fr_1fr_auto] sm:items-end"
      >
        <Field label="First name">
          <input
            type="text"
            name="firstName"
            required
            maxLength={100}
            defaultValue={defaults.firstName}
            className={inputStyles}
          />
        </Field>
        <Field label="Last name">
          <input
            type="text"
            name="lastName"
            required
            maxLength={100}
            defaultValue={defaults.lastName}
            className={inputStyles}
          />
        </Field>
        <Field label="Birthday" optional>
          <DateInput
            name="birthday"
            defaultValue={defaults.birthday}
            className={inputStyles}
          />
        </Field>
        <TermPicker
          defaultSeason={defaults.season}
          defaultYear={defaults.year}
        />
        <button
          type="submit"
          disabled={pending}
          className="h-10 rounded-md bg-gold px-4 text-sm font-semibold text-gold-ink shadow-[var(--shadow-sm)] transition-colors hover:bg-gold-hover disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
        >
          {pending ? "Adding…" : "Add"}
        </button>
      </form>
    </section>
  );
}

function Field({
  label,
  optional,
  children,
}: {
  label: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-baseline justify-between">
        <span className="text-xs uppercase tracking-wider text-fg-muted">
          {label}
        </span>
        {optional ? (
          <span className="text-[10px] text-fg-subtle">optional</span>
        ) : null}
      </span>
      {children}
    </label>
  );
}

const inputStyles =
  "w-full rounded-md bg-page border border-line text-fg placeholder:text-fg-subtle px-3 h-10 text-sm focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40";
