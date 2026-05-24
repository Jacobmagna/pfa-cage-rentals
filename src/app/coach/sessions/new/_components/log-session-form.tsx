"use client";

import { useActionState, useMemo } from "react";
import { CheckCircle2 } from "lucide-react";
import {
  logOwnSessionFormAction,
  type CoachActionResult,
} from "../form-actions";
import type { ResourceOption } from "../../_components/types";

const INITIAL_STATE: CoachActionResult = { ok: true, loggedAt: 0 };

// Mobile-first single-column form. Inputs are h-12 (48px) for
// comfortable tapping; submit is full-width on mobile, auto on
// desktop. After a successful submit:
//   - the success banner shows above the form
//   - the form remounts (keyed on loggedAt) so all fields reset to
//     fresh defaults
//   - the user can immediately log another session
// On error, the form remounts keyed to the error so uncontrolled
// inputs pick up state.values as defaultValue — preserving what the
// user typed.
export function LogSessionForm({
  resources,
}: {
  resources: ResourceOption[];
}) {
  const [state, formAction, pending] = useActionState(
    logOwnSessionFormAction,
    INITIAL_STATE,
  );

  const cages = resources.filter((r) => r.type === "cage");
  const bullpens = resources.filter((r) => r.type === "bullpen");
  const weightRooms = resources.filter((r) => r.type === "weight_room");

  // Default field values. On error: echo back what the user typed.
  // On fresh / post-success: compute "now rounded down to last 30-min
  // slot" so the coach can submit with minimal touch input. Memoized
  // on state so a successful submit (which bumps loggedAt and remounts
  // the form via key) gets a freshly computed "now".
  const defaults = useMemo(() => {
    if (!state.ok) {
      return state.values;
    }
    const start = roundDownToHalfHour(new Date());
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    return {
      resourceId: "",
      date: toDateInput(start),
      startTime: toTimeInput(start),
      endTime: toTimeInput(end),
      useType: "",
      note: "",
    };
  }, [state]);

  // Banner state. Success banner shown only when ok && we've actually
  // submitted (loggedAt > 0 distinguishes initial state from
  // post-submit success). Error banner shown when !ok.
  const showSuccess = state.ok && state.loggedAt > 0;
  const showError = !state.ok;

  // Form key drives the remount strategy:
  //   - success → key on loggedAt → fresh defaults
  //   - error   → key on error message → preserves echoed values
  //   - initial → stable key
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
          className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-300 flex items-center gap-2"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>Session logged. Ready for the next one.</span>
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
        <Field label="Resource">
          <select
            name="resourceId"
            required
            defaultValue={defaults.resourceId}
            className={selectStyles}
          >
            <option value="" disabled>
              Choose a resource…
            </option>
            {cages.length > 0 ? (
              <optgroup label="Cages">
                {cages.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {bullpens.length > 0 ? (
              <optgroup label="Bullpens">
                {bullpens.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {weightRooms.length > 0 ? (
              <optgroup label="Weight Room">
                {weightRooms.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
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
              step={1800}
              defaultValue={defaults.startTime}
              className={inputStyles}
            />
          </Field>
          <Field label="End">
            <input
              type="time"
              name="endTime"
              required
              step={1800}
              defaultValue={defaults.endTime}
              className={inputStyles}
            />
          </Field>
        </div>

        <Field
          label="Use type"
          hint="Required for cages (hitting or pitching). Leave blank for bullpens and weight rooms."
        >
          <select
            name="useType"
            defaultValue={defaults.useType}
            className={selectStyles}
          >
            <option value="">— None (bullpen / weight room)</option>
            <option value="hitting">Hitting</option>
            <option value="pitching">Pitching</option>
          </select>
        </Field>

        <Field label="Note" optional>
          <input
            type="text"
            name="note"
            defaultValue={defaults.note}
            maxLength={500}
            placeholder="Optional context (e.g. JP De La Cruz)"
            className={inputStyles}
          />
        </Field>

        <button
          type="submit"
          disabled={pending}
          className="w-full sm:w-auto rounded-md bg-gold text-gold-ink hover:bg-gold-hover h-12 px-6 text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
        >
          {pending ? "Logging…" : "Log session"}
        </button>
      </form>
    </div>
  );
}

function Field({
  label,
  hint,
  optional,
  children,
}: {
  label: string;
  hint?: string;
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
      {hint ? (
        <span className="block text-[11px] text-fg-subtle mt-1 leading-snug">
          {hint}
        </span>
      ) : null}
    </label>
  );
}

const inputStyles =
  "w-full rounded-md bg-page border border-line text-fg placeholder:text-fg-subtle px-3 h-12 text-base focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40";
const selectStyles = `${inputStyles} appearance-none pr-8`;

function roundDownToHalfHour(d: Date): Date {
  const copy = new Date(d.getTime());
  copy.setSeconds(0, 0);
  copy.setMinutes(copy.getMinutes() < 30 ? 0 : 30);
  return copy;
}

function toDateInput(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function toTimeInput(d: Date): string {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
