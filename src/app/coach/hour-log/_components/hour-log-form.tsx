"use client";

import { useActionState, useMemo, useState } from "react";
import { ChevronDown, AlertTriangle } from "lucide-react";
import {
  logOwnHourFormAction,
  type HourLogActionResult,
} from "../form-actions";
import { CompletionPanel } from "@/app/_components/completion-panel";
import { DateInput } from "@/app/_components/date-input";
import { TimeInput } from "@/app/_components/time-input";
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
    // Both non-ok variants (plain error AND requiresHold) echo the coach's
    // entered values back into the fields so nothing is lost.
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

  const requiresHold = !state.ok && "requiresHold" in state;
  const showError = !state.ok && !requiresHold;

  // Local dismissal for the hold warning: "Go back and edit" hides the banner
  // without submitting, keeping the entered values editable. We pin the
  // dismissal to the CURRENT warning's state OBJECT (useActionState hands us a
  // new object every submit), so a fresh anomaly from the next plain submit
  // re-shows the banner. Pure compare — no setState-in-effect.
  const [dismissedState, setDismissedState] =
    useState<HourLogActionResult | null>(null);
  const showHoldWarning = requiresHold && dismissedState !== state;

  // Collapse-to-confirmation: on a successful submit we hide the form
  // and render CompletionPanel in its place. `loggedAt` is the success
  // nonce; we ack it when the coach clicks "Log another hour", which
  // also lands us on a FRESH form (the key below includes the nonce).
  // Ephemeral + component-local → navigating away and back remounts to
  // the base form automatically. No setState-in-effect (pure compare).
  const successNonce = state.ok ? state.loggedAt : 0;
  const [ackedNonce, setAckedNonce] = useState(0);
  const showDone = successNonce > 0 && successNonce !== ackedNonce;

  // Stable form key so the fields don't unexpectedly remount/clear. The
  // requiresHold variant keys off the reason (not error.code, which it lacks).
  const formKey = state.ok
    ? state.loggedAt > 0
      ? `ok-${state.loggedAt}`
      : "fresh"
    : "requiresHold" in state
      ? `hold-${state.reason}`
      : `err-${state.error.code}-${state.error.message}`;

  // On a successful submit we collapse to a confirmation. A HELD log gets a
  // distinct "sent for approval" message; a normal post gets "Work logged."
  const wasHeld = state.ok && state.held === true;

  if (showDone) {
    return (
      <div className="space-y-4">
        <CompletionPanel
          message={
            wasHeld
              ? "Sent for approval — your admin will review it."
              : "Work logged."
          }
          actionLabel="Log more work"
          onAction={() => setAckedNonce(successNonce)}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {showError && !state.ok && "error" in state ? (
        <div
          role="alert"
          className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger"
        >
          {state.error.message}
        </div>
      ) : null}

      {showHoldWarning && !state.ok && "requiresHold" in state ? (
        <div
          role="alert"
          className="rounded-lg border border-line-strong bg-surface-2 px-3.5 py-3 text-sm text-fg"
        >
          <div className="flex items-start gap-2.5">
            <AlertTriangle
              className="mt-0.5 h-4 w-4 shrink-0 text-fg-muted"
              aria-hidden="true"
            />
            <div className="space-y-1">
              <p className="font-semibold">Needs admin approval</p>
              <p className="text-fg-muted leading-snug">{state.message}</p>
              <p className="text-fg-muted leading-snug">
                You can send this log to your admin for approval — it
                won&apos;t count or pay out until they review it — or go back
                and adjust the times.
              </p>
            </div>
          </div>
        </div>
      ) : null}

      <form action={formAction} key={formKey} className="space-y-5">
        <Field label="Work">
          <SelectWrapper>
            <select
              name="programId"
              required
              defaultValue={defaults.programId}
              className={selectStyles}
            >
              <option value="" disabled>
                Choose work…
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
          <DateInput
            name="date"
            required
            defaultValue={defaults.date}
            className={inputStyles}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Start">
            <TimeInput
              name="startTime"
              required
              defaultValue={defaults.startTime}
              className={inputStyles}
            />
          </Field>
          <Field label="End">
            <TimeInput
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

        {showHoldWarning ? (
          // Hold actions live INSIDE the form so they carry the entered
          // values. "Send to admin" is a named submit button → its
          // name/value pair (acknowledgeHold=true) rides in the FormData,
          // so the resubmit holds the row. "Go back and edit" only dismisses
          // the banner locally (no submit), leaving the fields editable.
          <div className="flex flex-col gap-2.5 sm:flex-row">
            <button
              type="submit"
              name="acknowledgeHold"
              value="true"
              disabled={pending}
              className="w-full sm:w-auto rounded-lg bg-gold text-gold-ink hover:bg-gold-hover shadow-[var(--shadow-sm)] h-12 px-6 text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
            >
              {pending ? "Sending…" : "Send to admin for approval"}
            </button>
            <button
              type="button"
              onClick={() => setDismissedState(state)}
              disabled={pending}
              className="w-full sm:w-auto rounded-lg border border-line-strong bg-surface text-fg-muted hover:text-fg hover:bg-surface-2 h-12 px-6 text-sm font-medium disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
            >
              Go back and edit
            </button>
          </div>
        ) : (
          <button
            type="submit"
            disabled={pending}
            className="w-full sm:w-auto rounded-lg bg-gold text-gold-ink hover:bg-gold-hover shadow-[var(--shadow-sm)] h-12 px-6 text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
          >
            {pending ? "Logging…" : "Log work"}
          </button>
        )}
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
