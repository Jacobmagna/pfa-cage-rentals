"use client";

import { useActionState, useMemo } from "react";
import { CheckCircle2, ChevronDown } from "lucide-react";
import {
  logOwnHourFormAction,
  type HourLogActionResult,
} from "../form-actions";
import { formatPfaDate } from "@/lib/timezone";

export type ProgramOption = {
  id: string;
  name: string;
};

const INITIAL_STATE: HourLogActionResult = { ok: true, loggedAt: 0 };

// Mobile-first single-column form. The form-action layer handles the
// submit via useActionState. On success it returns a `loggedAt` nonce
// we use as the form's remount key → the field defaults recompute and
// the form resets, ready for the next hour. On failure the errored
// values echo back into the fields. Mirrors the cage log-session form.
export function HourLogForm({ programs }: { programs: ProgramOption[] }) {
  const [state, formAction, pending] = useActionState(
    logOwnHourFormAction,
    INITIAL_STATE,
  );

  const defaults = useMemo(() => {
    if (!state.ok) {
      return state.values;
    }
    return {
      programId: "",
      date: formatPfaDate(new Date()),
      startTime: "",
      endTime: "",
      note: "",
    };
  }, [state]);

  const showSuccess = state.ok && state.loggedAt > 0;
  const showError = !state.ok;

  const formKey = state.ok
    ? state.loggedAt > 0
      ? `ok-${state.loggedAt}`
      : "fresh"
    : `err-${state.error.code}-${state.error.message}`;

  return (
    <div className="space-y-4">
      {showSuccess ? (
        <div
          role="status"
          className="rounded-md border border-success/30 bg-success/10 px-3 py-2.5 text-sm text-success flex items-center gap-2"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>Hour logged. Ready for the next one.</span>
        </div>
      ) : null}

      {showError ? (
        <div
          role="alert"
          className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger"
        >
          {state.error.message}
        </div>
      ) : null}

      <form action={formAction} key={formKey} className="space-y-5">
        <Field label="Program">
          <SelectWrapper>
            <select
              name="programId"
              required
              defaultValue={defaults.programId}
              className={selectStyles}
            >
              <option value="" disabled>
                Choose a program…
              </option>
              {programs.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </SelectWrapper>
        </Field>

        <Field label="Date">
          <input
            type="date"
            name="date"
            required
            defaultValue={defaults.date}
            className={inputStyles}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Start">
            <input
              type="time"
              name="startTime"
              required
              defaultValue={defaults.startTime}
              className={inputStyles}
            />
          </Field>
          <Field label="End">
            <input
              type="time"
              name="endTime"
              required
              defaultValue={defaults.endTime}
              className={inputStyles}
            />
          </Field>
        </div>

        <Field label="Note" optional>
          <textarea
            name="note"
            defaultValue={defaults.note}
            maxLength={2000}
            rows={3}
            placeholder="Optional context"
            className={`${inputStyles} h-auto py-2.5 resize-y`}
          />
        </Field>

        <button
          type="submit"
          disabled={pending}
          className="w-full sm:w-auto rounded-lg bg-gold text-gold-ink hover:bg-gold-hover shadow-[var(--shadow-sm)] h-12 px-6 text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
        >
          {pending ? "Logging…" : "Log hour"}
        </button>
      </form>
    </div>
  );
}

// Wraps a <select> so a custom chevron overlays the input. Matches the
// cage log-session form's SelectWrapper (iOS Safari renders the native
// chevron at low contrast otherwise).
function SelectWrapper({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative">
      {children}
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-fg-subtle"
      />
    </div>
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
      <span className="flex items-baseline justify-between mb-1.5">
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
  "w-full rounded-lg bg-surface border border-line text-fg placeholder:text-fg-subtle px-3 h-12 text-base focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40";
const selectStyles = `${inputStyles} appearance-none pr-8`;
