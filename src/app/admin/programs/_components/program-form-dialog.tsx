"use client";

import { useActionState, useEffect, useMemo, useRef } from "react";
import { X } from "lucide-react";
import {
  updateProgramFormAction,
  type EditProgramResult,
} from "../form-actions";
import { ProgramFields } from "./program-fields";

export type ProgramEditInitialValues = {
  id: string;
  name: string;
  cap: number | null;
  capPeriod: "week" | "month" | null;
  defaultRatePer30MinCents: number | null;
};

// Native <dialog> edit form for a single program (name + optional cap /
// period via the shared ProgramFields) using useActionState +
// updateProgramFormAction, auto-closing on success. Mirrors
// admin/attendance/roster/_components/athlete-edit-dialog.tsx. Create
// mode lives in the inline AddProgramForm at the top of the page.

const INITIAL_STATE: EditProgramResult = { ok: true };

export function ProgramFormDialog({
  open,
  onClose,
  initial,
}: {
  open: boolean;
  onClose: () => void;
  initial?: ProgramEditInitialValues;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [state, formAction, pending] = useActionState(
    updateProgramFormAction,
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
      const hasCap = initial.cap !== null && initial.capPeriod !== null;
      return {
        name: initial.name,
        cap: initial.cap !== null ? String(initial.cap) : "",
        capPeriod: initial.capPeriod ?? "",
        limit: hasCap,
        rateDollars:
          initial.defaultRatePer30MinCents !== null
            ? (initial.defaultRatePer30MinCents / 100).toFixed(2)
            : "",
      };
    }
    return { name: "", cap: "", capPeriod: "", limit: false, rateDollars: "" };
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
              Program
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

        <ProgramFields defaults={defaults} />

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
