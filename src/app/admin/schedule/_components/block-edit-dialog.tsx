"use client";

// Click-an-existing-block flow. Mirrors SessionFormDialog's edit
// surface but for blocked_times rows. Delete lives inside the dialog
// (per the H1 click-UX call) rather than as a separate click affordance
// on the grid — single mental model: click anything → edit it.
//
// Create-side blocks still go through ScheduleCreateDialog's Block
// tab; this component is edit-only.

import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import { Trash2, X } from "lucide-react";
import {
  deleteBlockAction,
  updateBlockFormAction,
  type BlockActionResult,
} from "../form-actions";
import type { ResourceOption } from "@/app/admin/sessions/_components/sessions-client";
import { TimeSelect } from "@/app/_components/time-select";
import { formatPfaDate, formatPfaDateMedium, formatPfaTime } from "@/lib/timezone";
import { ConfirmDialog } from "@/app/_components/confirm-dialog";

export type BlockEditInitialValues = {
  id: string;
  resourceId: string;
  startAt: Date;
  endAt: Date;
  reason: string;
};

const INITIAL_STATE: BlockActionResult = { ok: true };

export function BlockEditDialog({
  open,
  onClose,
  resources,
  initial,
}: {
  open: boolean;
  onClose: () => void;
  resources: ResourceOption[];
  initial?: BlockEditInitialValues;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [state, formAction, pending] = useActionState(
    updateBlockFormAction,
    INITIAL_STATE,
  );
  const [deleting, setDeleting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  // Auto-close after a successful update.
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

  // Same defaults priority as SessionFormDialog: errored submission →
  // initial values → empty skeleton.
  const defaults = useMemo(() => {
    if (!state.ok && state.values) return state.values;
    if (initial) {
      return {
        resourceId: initial.resourceId,
        date: toDateInput(initial.startAt),
        startTime: toTimeInput(initial.startAt),
        endTime: toTimeInput(initial.endAt),
        reason: initial.reason,
      };
    }
    return {
      resourceId: "",
      date: "",
      startTime: "09:00",
      endTime: "10:00",
      reason: "",
    };
  }, [initial, state]);

  const handleDelete = () => {
    if (!initial) return;
    setConfirmOpen(true);
  };

  const handleConfirmDelete = async () => {
    if (!initial) return;
    setDeleting(true);
    try {
      await deleteBlockAction(initial.id);
      setConfirmOpen(false);
      onClose();
    } finally {
      setDeleting(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="m-auto w-full max-w-lg rounded-xl border border-line bg-surface text-fg p-0 shadow-[var(--shadow-lg)] backdrop:bg-page/70 backdrop:backdrop-blur-sm"
    >
      <form
        action={formAction}
        // Key includes initial.id so opening edit on a different block
        // remounts the inputs with the right defaultValues. Bumps on
        // error too so the user's submitted values re-populate.
        key={
          state.ok
            ? `block-edit-${initial?.id ?? "none"}`
            : `block-edit-err-${state.error.code}-${state.error.message}`
        }
        className="space-y-5 p-6"
      >
        {initial ? (
          <input type="hidden" name="id" defaultValue={initial.id} />
        ) : null}

        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.14em] text-fg-muted">
              Edit
            </p>
            <h2 className="text-xl font-semibold tracking-tight mt-0.5">
              Block
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
              {resources.map((r) => (
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
            label="Reason"
            hint="Free text — e.g. 'Summer Camp Group 5', 'HVAC repair'."
          >
            <input
              type="text"
              name="reason"
              required
              maxLength={120}
              defaultValue={defaults.reason}
              className={inputStyles}
            />
          </Field>
        </div>

        <div className="flex items-center justify-between gap-2 pt-2">
          <button
            type="button"
            onClick={handleDelete}
            disabled={deleting || pending}
            className="inline-flex items-center gap-1.5 rounded-md border border-danger/30 bg-danger/10 text-danger hover:bg-danger/20 h-9 px-3 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 transition-colors"
          >
            <Trash2 className="h-4 w-4" />
            {deleting ? "Deleting…" : "Delete block"}
          </button>
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
              {pending ? "Saving…" : "Save changes"}
            </button>
          </div>
        </div>
      </form>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={(next) => {
          if (!deleting) setConfirmOpen(next);
        }}
        title="Delete this block?"
        description={
          initial
            ? `"${initial.reason}" · ${formatPfaDateMedium(initial.startAt)} · ${formatPfaTime(initial.startAt)} – ${formatPfaTime(initial.endAt)}. This can't be undone.`
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

// Inputs render PFA wall-clock — same value regardless of viewer's browser TZ.
const toDateInput = formatPfaDate;
const toTimeInput = formatPfaTime;
