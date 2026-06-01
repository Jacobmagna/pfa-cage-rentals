"use client";

import { useActionState, useEffect, useRef } from "react";
import { X } from "lucide-react";
import {
  setProgramCoachesFormAction,
  type SetCoachesResult,
} from "../form-actions";
import { MultiSelect } from "@/app/_components/multi-select";

export type CoachOption = { value: string; label: string };

// Native <dialog> for assigning which coaches run a program (DEC-23).
// The MultiSelect emits one hidden <input name="coachId"> per selection;
// the form-action reads them as the program's exact coach set (replace-
// set — DEC-04). Auto-closes on success. Mirrors the dialog lifecycle of
// program-form-dialog.tsx; reuses the shared MultiSelect island.

const INITIAL_STATE: SetCoachesResult = { ok: true, savedAt: 0 };

export function ProgramCoachesDialog({
  open,
  onClose,
  programId,
  programName,
  coachOptions,
  currentCoachIds,
}: {
  open: boolean;
  onClose: () => void;
  programId: string | null;
  programName: string | null;
  coachOptions: CoachOption[];
  currentCoachIds: string[];
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [state, formAction, pending] = useActionState(
    setProgramCoachesFormAction,
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

  // Auto-close after a successful save.
  const wasPending = useRef(false);
  useEffect(() => {
    if (wasPending.current && !pending && state.ok && state.savedAt > 0 && open) {
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

  return (
    <dialog
      ref={dialogRef}
      className="m-auto w-full max-w-lg rounded-lg border border-line bg-surface text-fg p-0 backdrop:bg-page/70 backdrop:backdrop-blur-sm"
    >
      <form
        action={formAction}
        // Remount per-program so the MultiSelect re-seeds defaultSelected
        // and a prior error banner clears when switching rows.
        key={`coaches-${programId ?? "none"}-${state.ok ? "ok" : state.error.code}`}
        className="space-y-5 p-6"
      >
        <input type="hidden" name="programId" defaultValue={programId ?? ""} />

        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.14em] text-fg-muted">
              Coaches
            </p>
            <h2 className="mt-0.5 text-xl font-semibold tracking-tight">
              {programName ?? "Program"}
            </h2>
            <p className="mt-1 text-xs text-fg-subtle">
              These coaches can log hours + take attendance for this program.
            </p>
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

        {coachOptions.length === 0 ? (
          <p className="text-sm text-fg-muted">
            No active coaches yet. Add a coach first.
          </p>
        ) : (
          <div>
            <span className="mb-1.5 block text-xs uppercase tracking-wider text-fg-muted">
              Assigned coaches
            </span>
            <MultiSelect
              name="coachId"
              options={coachOptions}
              defaultSelected={currentCoachIds}
              placeholder="No coaches assigned"
              searchPlaceholder="Search coaches…"
              aria-label="Assigned coaches"
            />
          </div>
        )}

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
            className="h-9 rounded-md bg-gold px-4 text-sm font-medium text-gold-ink transition-colors hover:bg-gold-hover disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
          >
            {pending ? "Saving…" : "Save coaches"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
