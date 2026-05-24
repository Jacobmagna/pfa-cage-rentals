"use client";

import { useActionState, useEffect, useMemo, useRef } from "react";
import { X } from "lucide-react";
import {
  createSessionFormAction,
  updateSessionFormAction,
  type ActionResult,
} from "../form-actions";
import type { CoachOption, ResourceOption } from "./sessions-client";

export type SessionFormInitialValues = {
  id: string;
  coachId: string;
  resourceId: string;
  startAt: Date;
  endAt: Date;
  useType: "hitting" | "pitching" | null;
  note: string | null;
};

// Modal form for creating or editing a session. Uses the native
// <dialog> element — modern browsers handle the backdrop, focus
// trap, and Escape-to-close for free. Styled with our design
// tokens via the open: attribute.
//
// useActionState lets the server action return a typed result that
// becomes part of the form's state without a try/catch. On
// successful submit, parent closes via the onClose prop.
//
// Date/time strategy: the underlying schema wants Date objects.
// HTML gives us split date + time inputs (more reliable on mobile
// than datetime-local). form-actions.ts combines them.

const INITIAL_STATE: ActionResult = { ok: true };

export function SessionFormDialog({
  open,
  mode,
  onClose,
  coachOptions,
  resourceOptions,
  initial,
}: {
  open: boolean;
  mode: "create" | "edit";
  onClose: () => void;
  coachOptions: CoachOption[];
  resourceOptions: ResourceOption[];
  initial?: SessionFormInitialValues;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const action =
    mode === "edit" ? updateSessionFormAction : createSessionFormAction;
  const [state, formAction, pending] = useActionState(action, INITIAL_STATE);

  // Sync dialog open state with React state.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Auto-close after a successful submit.
  const wasPending = useRef(false);
  useEffect(() => {
    if (wasPending.current && !pending && state.ok && open) {
      onClose();
    }
    wasPending.current = pending;
  }, [pending, state, open, onClose]);

  // Listen for the dialog's native close event (Escape key, backdrop click).
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handler = () => {
      if (open) onClose();
    };
    dialog.addEventListener("close", handler);
    return () => dialog.removeEventListener("close", handler);
  }, [open, onClose]);

  // Defaults priority: errored-submission values (so users don't
  // re-pick after an overlap) → initial values (edit mode) → empty
  // skeleton (new mode). Forms are uncontrolled and `defaultValue`
  // only applies on mount, so the form is keyed below to force a
  // remount whenever this set changes (on error, mode switch, etc.).
  const defaults = useMemo(() => {
    if (!state.ok && state.values) {
      return state.values;
    }
    if (initial) {
      return {
        coachId: initial.coachId,
        resourceId: initial.resourceId,
        date: toDateInput(initial.startAt),
        startTime: toTimeInput(initial.startAt),
        endTime: toTimeInput(initial.endAt),
        useType: initial.useType ?? "",
        note: initial.note ?? "",
      };
    }
    const now = new Date();
    return {
      coachId: "",
      resourceId: "",
      date: toDateInput(now),
      startTime: "09:00",
      endTime: "10:00",
      useType: "",
      note: "",
    };
  }, [initial, state]);

  // For the useType visibility: which resource is selected? Re-derived
  // from the form's current state via a ref + uncontrolled inputs would
  // be more code; we just always render the useType row and let the
  // server-side validator catch mismatches with a friendly error.
  // Trade-off: one more click for the admin if they pick the wrong
  // option. Worth it for code simplicity.

  return (
    <dialog
      ref={dialogRef}
      className="m-auto w-full max-w-lg rounded-lg border border-line bg-surface text-fg p-0 backdrop:bg-page/70 backdrop:backdrop-blur-sm"
    >
      <form
        action={formAction}
        // Key bumps on error (so uncontrolled inputs remount with the
        // user's submitted values via defaultValue) AND on identity
        // changes (so opening edit on a different row remounts with
        // the new initial values, instead of keeping the first row's
        // values locked in defaultValue).
        key={
          state.ok
            ? `${mode}-${initial?.id ?? "new"}`
            : `${mode}-err-${state.error.code}-${state.error.message}`
        }
        className="space-y-5 p-6"
      >
        {mode === "edit" && initial ? (
          <input type="hidden" name="id" defaultValue={initial.id} />
        ) : null}

        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.14em] text-fg-muted">
              {mode === "edit" ? "Edit" : "New"}
            </p>
            <h2 className="text-xl font-semibold tracking-tight mt-0.5">
              Session details
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center justify-center h-8 w-8 -mr-1 -mt-1 rounded-md text-fg-muted hover:text-fg hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {!state.ok ? (
          <div
            role="alert"
            className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
          >
            {state.error.message}
          </div>
        ) : null}

        <div className="space-y-3">
          <Field label="Coach">
            <select
              name="coachId"
              required
              defaultValue={defaults.coachId}
              className={selectStyles}
            >
              <option value="" disabled>
                Choose a coach…
              </option>
              {coachOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name ?? c.email}
                </option>
              ))}
            </select>
          </Field>

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
              {resourceOptions.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </Field>

          <div className="grid grid-cols-3 gap-3">
            <Field label="Date">
              <input
                type="date"
                name="date"
                required
                defaultValue={defaults.date}
                className={inputStyles}
              />
            </Field>
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
              placeholder="Optional context (e.g. JP De La Cruz, online)"
              className={inputStyles}
            />
          </Field>
        </div>

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-line bg-surface-2 text-fg-muted hover:text-fg hover:border-line-strong h-9 px-4 text-sm font-medium transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-gold text-gold-ink hover:bg-gold-hover h-9 px-4 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
          >
            {pending
              ? "Saving…"
              : mode === "edit"
                ? "Save changes"
                : "Create session"}
          </button>
        </div>
      </form>
    </dialog>
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
  "w-full rounded-md bg-page border border-line text-fg placeholder:text-fg-subtle px-3 py-2 text-sm focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40";
const selectStyles = `${inputStyles} appearance-none pr-8`;

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
