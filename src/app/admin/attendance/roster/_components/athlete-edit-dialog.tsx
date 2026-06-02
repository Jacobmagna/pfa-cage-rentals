"use client";

import { useActionState, useEffect, useMemo, useRef } from "react";
import { X } from "lucide-react";
import {
  updateAthleteFormAction,
  type EditAthleteResult,
} from "../form-actions";
import { TermPicker, parseTerm } from "./term-picker";

export type AthleteEditInitialValues = {
  id: string;
  firstName: string;
  lastName: string;
  birthday: string | null;
  term: string | null;
};

// Native <dialog> edit form for a single athlete (first / last /
// birthday) via useActionState + form-action, auto-closing on success.
// Mirrors admin/hour-log/_components/hour-edit-dialog.tsx.

const INITIAL_STATE: EditAthleteResult = { ok: true };

export function AthleteEditDialog({
  open,
  onClose,
  initial,
}: {
  open: boolean;
  onClose: () => void;
  initial?: AthleteEditInitialValues;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [state, formAction, pending] = useActionState(
    updateAthleteFormAction,
    INITIAL_STATE,
  );

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

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handler = () => {
      if (open) onClose();
    };
    dialog.addEventListener("close", handler);
    return () => dialog.removeEventListener("close", handler);
  }, [open, onClose]);

  const defaults = useMemo(() => {
    if (!state.ok && state.values) {
      return state.values;
    }
    if (initial) {
      const { season, year } = parseTerm(initial.term);
      return {
        firstName: initial.firstName,
        lastName: initial.lastName,
        birthday: initial.birthday ?? "",
        season,
        year,
      };
    }
    return { firstName: "", lastName: "", birthday: "", season: "", year: "" };
  }, [initial, state]);

  return (
    <dialog
      ref={dialogRef}
      className="m-auto w-full max-w-lg rounded-xl border border-line bg-surface text-fg p-0 shadow-[var(--shadow-lg)] backdrop:bg-page/70 backdrop:backdrop-blur-sm"
    >
      <form
        action={formAction}
        key={
          state.ok
            ? `edit-${initial?.id ?? "none"}`
            : `edit-err-${state.error.code}-${state.error.message}`
        }
        className="space-y-5 p-6"
      >
        <input type="hidden" name="id" defaultValue={initial?.id ?? ""} />

        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.14em] text-fg-muted">
              Edit
            </p>
            <h2 className="mt-0.5 text-xl font-semibold tracking-tight">
              Athlete
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="-mr-1 -mt-1 inline-flex h-8 w-8 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
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
          <div className="grid grid-cols-2 gap-3">
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
          </div>
          <Field label="Birthday" optional>
            <input
              type="date"
              name="birthday"
              defaultValue={defaults.birthday}
              className={inputStyles}
            />
          </Field>
          <TermPicker
            defaultSeason={defaults.season}
            defaultYear={defaults.year}
          />
        </div>

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-md border border-line bg-surface-2 px-4 text-sm font-medium text-fg-muted transition-colors hover:border-line-strong hover:text-fg"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={pending}
            className="h-9 rounded-md bg-gold px-4 text-sm font-medium text-gold-ink shadow-[var(--shadow-sm)] transition-colors hover:bg-gold-hover disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
          >
            {pending ? "Saving…" : "Save changes"}
          </button>
        </div>
      </form>
    </dialog>
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
  "w-full rounded-md bg-page border border-line text-fg placeholder:text-fg-subtle px-3 py-2 text-sm focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40";
