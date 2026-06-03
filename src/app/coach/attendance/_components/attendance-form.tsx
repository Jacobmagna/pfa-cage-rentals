"use client";

// Roster checklist for a single program + date. Each athlete renders a
// labeled checkbox (name="present", value=athleteId) prefilled from the
// already-saved records, plus a hidden name="athleteId" carrying the
// FULL roster so the form-action can mark omitted athletes absent. The
// internal action reconciles again against the live roster.
//
// useActionState drives the submit. On success we show a confirmation
// banner and KEEP the coach on the page — the prefill already reflects
// the saved state (unchecked = absent), so re-submitting edits the same
// session. The form is remounted on each result via a key so the
// pending-button state resets cleanly. Mirrors the coach hour-log form.

import { useActionState, useState } from "react";
import {
  submitOwnAttendanceFormAction,
  type AttendanceActionResult,
} from "../form-actions";
import { CompletionPanel } from "@/app/_components/completion-panel";

export type RosterAthlete = {
  id: string;
  firstName: string;
  lastName: string;
  present: boolean;
};

const INITIAL_STATE: AttendanceActionResult = {
  ok: true,
  savedAt: 0,
  present: 0,
  total: 0,
};

export function AttendanceForm({
  programId,
  sessionDate,
  roster,
}: {
  programId: string;
  sessionDate: string;
  roster: RosterAthlete[];
}) {
  const [state, formAction, pending] = useActionState(
    submitOwnAttendanceFormAction,
    INITIAL_STATE,
  );

  const showError = !state.ok;

  // Collapse-to-confirmation: on a successful save we hide the roster
  // form and render CompletionPanel in its place. `savedAt` is the
  // success nonce; "Edit attendance" acks it and returns to the form,
  // which prefills from the now-saved state (re-submitting edits the
  // SAME session), NOT a blank form. Ephemeral + component-local so
  // navigating away and back remounts to the base form. No
  // setState-in-effect (pure compare).
  const successNonce = state.ok ? state.savedAt : 0;
  const present = state.ok ? state.present : 0;
  const total = state.ok ? state.total : 0;
  const [ackedNonce, setAckedNonce] = useState(0);
  const showDone = successNonce > 0 && successNonce !== ackedNonce;

  // Remount on each distinct result so the checkboxes pick the latest
  // server-rendered prefill (the page re-renders after revalidatePath)
  // and pending state resets.
  const formKey = state.ok
    ? state.savedAt > 0
      ? `ok-${state.savedAt}`
      : "fresh"
    : `err-${state.error.code}-${state.error.message}`;

  if (showDone) {
    return (
      <div className="space-y-4 max-w-md">
        <CompletionPanel
          message={`Attendance saved — ${present} of ${total} present.`}
          actionLabel="Edit attendance"
          onAction={() => setAckedNonce(successNonce)}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-md">
      {showError ? (
        <div
          role="alert"
          className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger"
        >
          {state.error.message}
        </div>
      ) : null}

      <form action={formAction} key={formKey} className="space-y-4">
        <input type="hidden" name="programId" value={programId} />
        <input type="hidden" name="sessionDate" value={sessionDate} />

        <ul className="divide-y divide-line rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)] overflow-hidden">
          {roster.map((athlete) => (
            <li key={athlete.id} className="transition hover:bg-surface-2">
              <input type="hidden" name="athleteId" value={athlete.id} />
              <label className="flex items-center gap-3 px-4 py-3 cursor-pointer">
                <input
                  type="checkbox"
                  name="present"
                  value={athlete.id}
                  defaultChecked={athlete.present}
                  className="h-5 w-5 shrink-0 rounded border-line text-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 accent-gold"
                />
                <span className="text-sm text-fg">
                  {athlete.lastName}, {athlete.firstName}
                </span>
              </label>
            </li>
          ))}
        </ul>

        <button
          type="submit"
          disabled={pending}
          className="w-full sm:w-auto rounded-lg bg-gold text-gold-ink hover:bg-gold-hover shadow-[var(--shadow-sm)] h-12 px-6 text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
        >
          {pending ? "Saving…" : "Save attendance"}
        </button>
      </form>
    </div>
  );
}
