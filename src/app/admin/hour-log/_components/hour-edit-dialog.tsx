"use client";

import { useActionState, useEffect, useMemo, useRef } from "react";
import { X } from "lucide-react";
import {
  updateHourFormAction,
  type HourActionResult,
} from "../form-actions";
import { TimeSelect } from "@/app/_components/time-select";
import { DateInput } from "@/app/_components/date-input";
import { formatPfaDate, formatPfaTime } from "@/lib/timezone";

export type HourEditInitialValues = {
  id: string;
  programId: string;
  programName: string;
  startAt: Date;
  endAt: Date;
  note: string | null;
};

// Modal form for editing a single logged hour. Edits the date / start /
// end / note only — the entry stays bound to its original program
// (carried as a hidden field so editHourLogSchema, which requires
// programId, parses). Mirrors the edit path of
// admin/sessions/_components/session-form-dialog.tsx.

const INITIAL_STATE: HourActionResult = { ok: true };

export function HourEditDialog({
  open,
  onClose,
  initial,
}: {
  open: boolean;
  onClose: () => void;
  initial?: HourEditInitialValues;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [state, formAction, pending] = useActionState(
    updateHourFormAction,
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
      return {
        programId: initial.programId,
        date: formatPfaDate(initial.startAt),
        startTime: formatPfaTime(initial.startAt),
        endTime: formatPfaTime(initial.endAt),
        note: initial.note ?? "",
      };
    }
    return {
      programId: "",
      date: "",
      startTime: "09:00",
      endTime: "10:00",
      note: "",
    };
  }, [initial, state]);

  return (
    <dialog
      ref={dialogRef}
      className="m-auto w-full max-w-lg rounded-lg border border-line bg-surface text-fg p-0 backdrop:bg-page/70 backdrop:backdrop-blur-sm"
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
        <input
          type="hidden"
          name="programId"
          defaultValue={defaults.programId}
        />

        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.14em] text-fg-muted">
              Edit
            </p>
            <h2 className="text-xl font-semibold tracking-tight mt-0.5">
              Hour log entry
            </h2>
            {initial ? (
              <p className="text-xs text-fg-subtle mt-1">
                {initial.programName}
              </p>
            ) : null}
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
          <div className="grid grid-cols-3 gap-3">
            <Field label="Date">
              <DateInput
                name="date"
                required
                defaultValue={defaults.date}
                className={inputStyles}
              />
            </Field>
            <Field label="Start">
              <TimeSelect
                name="startTime"
                variant="start"
                required
                defaultValue={defaults.startTime}
                className={selectStyles}
              />
            </Field>
            <Field label="End">
              <TimeSelect
                name="endTime"
                variant="end"
                required
                defaultValue={defaults.endTime}
                className={selectStyles}
              />
            </Field>
          </div>

          <Field label="Note" optional>
            <input
              type="text"
              name="note"
              defaultValue={defaults.note}
              maxLength={2000}
              placeholder="Optional context"
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
  "w-full rounded-md bg-page border border-line text-fg placeholder:text-fg-subtle px-3 py-2 text-sm focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40";
const selectStyles = `${inputStyles} appearance-none pr-8`;
