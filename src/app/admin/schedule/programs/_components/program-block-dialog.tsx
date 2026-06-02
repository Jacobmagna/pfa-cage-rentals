"use client";

// Create + edit dialog for program schedule blocks (SCR-1a). Mirrors
// block-edit-dialog.tsx: native <dialog>, useActionState, focus/Escape/
// close, role="alert" errors. One component serves both modes:
//   - create: seeded with the clicked cell's program + start time
//     (default end = start + 60 min). No Delete button.
//   - edit:   populated from the clicked block. Shows a Delete button
//     (ConfirmDialog).
//
// The date is the grid's selected date (fixed, hidden). Fields:
// program <select>, scheduled-coach <select>, start/end <TimeSelect>,
// optional note (max 200). form-actions composes startAt/endAt from the
// submitted date + start/end times via parsePfaInput.

import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import { Trash2, X } from "lucide-react";
import {
  createProgramScheduleBlockFormAction,
  deleteProgramScheduleBlockAction,
  updateProgramScheduleBlockFormAction,
  type ProgramScheduleActionResult,
} from "../form-actions";
import { TimeSelect } from "@/app/_components/time-select";
import { ConfirmDialog } from "@/app/_components/confirm-dialog";
import type { BlockReconciliation } from "@/lib/server/reconciliation";
import {
  formatPfaDate,
  formatPfaDateMedium,
  formatPfaTime,
} from "@/lib/timezone";

export type ProgramOption = { id: string; name: string };
export type CoachOption = {
  id: string;
  name: string | null;
  email: string;
};

export type ProgramBlockEditInitial = {
  id: string;
  programId: string;
  scheduledCoachId: string;
  startAt: Date;
  endAt: Date;
  note: string | null;
};

const INITIAL_STATE: ProgramScheduleActionResult = { ok: true };

// Status banner labels + colors for the edit-mode reconciliation note
// (FEAT-16). logged → success, mismatches → danger, pending → neutral.
const RECON_STATUS_LABELS: Record<BlockReconciliation["status"], string> = {
  logged: "On schedule",
  wrong_coach: "Wrong coach",
  wrong_time: "Wrong time",
  no_show: "No-show",
  pending: "Pending",
};

function reconBannerStyles(status: BlockReconciliation["status"]): string {
  switch (status) {
    case "logged":
      return "border-success/30 bg-success/10 text-success";
    case "wrong_coach":
    case "wrong_time":
    case "no_show":
      return "border-danger/30 bg-danger/10 text-danger";
    default:
      return "border-line bg-surface-2 text-fg-muted";
  }
}

export function ProgramBlockDialog({
  open,
  mode,
  onClose,
  date,
  programs,
  coaches,
  createPrefill,
  editInitial,
  reconciliation,
}: {
  open: boolean;
  mode: "create" | "edit";
  onClose: () => void;
  date: Date;
  programs: ProgramOption[];
  coaches: CoachOption[];
  createPrefill: { programId: string; startTime: string; endTime: string } | null;
  editInitial: ProgramBlockEditInitial | null;
  reconciliation?: BlockReconciliation | null;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const isEdit = mode === "edit";

  const [state, formAction, pending] = useActionState(
    isEdit
      ? updateProgramScheduleBlockFormAction
      : createProgramScheduleBlockFormAction,
    INITIAL_STATE,
  );
  const [deleting, setDeleting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  // Auto-close after a successful submit.
  const wasPending = useRef(false);
  useEffect(() => {
    if (wasPending.current && !pending && state.ok && open) onClose();
    wasPending.current = pending;
  }, [pending, state, open, onClose]);

  // Native close (Escape, backdrop click).
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handler = () => {
      if (open) onClose();
    };
    dialog.addEventListener("close", handler);
    return () => dialog.removeEventListener("close", handler);
  }, [open, onClose]);

  // Defaults priority: errored submission → initial/prefill values →
  // empty skeleton. The date is always the grid's selected date.
  const dateInput = formatPfaDate(date);
  const defaults = useMemo(() => {
    if (!state.ok && state.values) {
      return {
        programId: state.values.programId,
        scheduledCoachId: state.values.scheduledCoachId,
        startTime: state.values.startTime,
        endTime: state.values.endTime,
        note: state.values.note,
      };
    }
    if (isEdit && editInitial) {
      return {
        programId: editInitial.programId,
        scheduledCoachId: editInitial.scheduledCoachId,
        startTime: formatPfaTime(editInitial.startAt),
        endTime: formatPfaTime(editInitial.endAt),
        note: editInitial.note ?? "",
      };
    }
    if (!isEdit && createPrefill) {
      return {
        programId: createPrefill.programId,
        scheduledCoachId: "",
        startTime: createPrefill.startTime,
        endTime: createPrefill.endTime,
        note: "",
      };
    }
    return {
      programId: "",
      scheduledCoachId: "",
      startTime: "09:00",
      endTime: "10:00",
      note: "",
    };
  }, [isEdit, editInitial, createPrefill, state]);

  const handleDelete = () => {
    if (!editInitial) return;
    setDeleteError(null);
    setConfirmOpen(true);
  };

  const handleConfirmDelete = async () => {
    if (!editInitial) return;
    setDeleting(true);
    try {
      const result = await deleteProgramScheduleBlockAction(editInitial.id);
      if (result.ok) {
        setConfirmOpen(false);
        onClose();
      } else {
        setDeleteError(result.error.message);
        setConfirmOpen(false);
      }
    } finally {
      setDeleting(false);
    }
  };

  // Key remounts the inputs when switching between blocks / modes and
  // re-populates submitted values on error.
  const formKey = state.ok
    ? `psb-${mode}-${editInitial?.id ?? createPrefill?.programId ?? "none"}-${defaults.startTime}`
    : `psb-err-${state.error.code}-${state.error.message}`;

  return (
    <dialog
      ref={dialogRef}
      className="m-auto w-full max-w-lg rounded-xl border border-line bg-surface text-fg p-0 shadow-[var(--shadow-lg)] backdrop:bg-page/70 backdrop:backdrop-blur-sm"
    >
      <form action={formAction} key={formKey} className="space-y-5 p-6">
        {isEdit && editInitial ? (
          <input type="hidden" name="id" defaultValue={editInitial.id} />
        ) : null}
        <input type="hidden" name="date" defaultValue={dateInput} />

        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.14em] text-fg-muted">
              {isEdit ? "Edit" : "Schedule"}
            </p>
            <h2 className="text-xl font-semibold tracking-tight mt-0.5">
              Program block
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

        {deleteError ? (
          <div
            role="alert"
            className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
          >
            {deleteError}
          </div>
        ) : null}

        {isEdit && reconciliation ? (
          <div
            role="status"
            className={`rounded-md border px-3 py-2 text-xs ${reconBannerStyles(
              reconciliation.status,
            )}`}
          >
            <span className="font-medium uppercase tracking-wider">
              {RECON_STATUS_LABELS[reconciliation.status]}
            </span>
            <span className="block mt-0.5">{reconciliation.detail}</span>
          </div>
        ) : null}

        <div className="space-y-3">
          <Field label="Program">
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
          </Field>

          <Field label="Scheduled coach">
            <select
              name="scheduledCoachId"
              required
              defaultValue={defaults.scheduledCoachId}
              className={selectStyles}
            >
              <option value="" disabled>
                Choose a coach…
              </option>
              {coaches.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name ?? c.email}
                </option>
              ))}
            </select>
          </Field>

          <div className="grid grid-cols-2 gap-3">
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

          <Field
            label="Note"
            hint="Optional — e.g. 'Bring radar gun', context for the coach."
          >
            <input
              type="text"
              name="note"
              maxLength={200}
              defaultValue={defaults.note}
              className={inputStyles}
            />
          </Field>
        </div>

        <div className="flex items-center justify-between gap-2 pt-2">
          {isEdit ? (
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting || pending}
              className="inline-flex items-center gap-1.5 rounded-md border border-danger/30 bg-danger/10 text-danger hover:bg-danger/20 h-9 px-3 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 transition-colors"
            >
              <Trash2 className="h-4 w-4" />
              {deleting ? "Deleting…" : "Delete block"}
            </button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-line bg-surface-2 text-fg-muted hover:text-fg hover:border-line-strong h-9 px-4 text-sm font-medium transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending || deleting}
              className="rounded-md bg-gold text-gold-ink shadow-[var(--shadow-sm)] hover:bg-gold-hover h-9 px-4 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
            >
              {pending
                ? "Saving…"
                : isEdit
                  ? "Save changes"
                  : "Schedule block"}
            </button>
          </div>
        </div>
      </form>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={(next) => {
          if (!deleting) setConfirmOpen(next);
        }}
        title="Delete this program block?"
        description={
          editInitial
            ? `${formatPfaDateMedium(editInitial.startAt)} · ${formatPfaTime(editInitial.startAt)} – ${formatPfaTime(editInitial.endAt)}. This can't be undone.`
            : undefined
        }
        confirmLabel={deleting ? "Deleting…" : "Delete block"}
        onConfirm={handleConfirmDelete}
        isPending={deleting}
      />
    </dialog>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-xs uppercase tracking-wider text-fg-muted block mb-1.5">
        {label}
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
