"use client";

// Click-an-existing-block flow. Mirrors SessionFormDialog's edit
// surface but for blocked_times rows. Delete lives inside the dialog
// (per the H1 click-UX call) rather than as a separate click affordance
// on the grid — single mental model: click anything → edit it.
//
// Create-side blocks still go through ScheduleCreateDialog's Block
// tab; this component is edit-only.

import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Repeat, Trash2, X } from "lucide-react";
import {
  deleteBlockAction,
  updateBlockFormAction,
  type BlockActionResult,
} from "../form-actions";
import { cancelBlockOccurrence, deleteBlockSeries } from "../actions";
import type { ResourceOption } from "@/app/admin/sessions/_components/sessions-client";
import { TimeSelect } from "@/app/_components/time-select";
import { DateInput } from "@/app/_components/date-input";
import {
  formatPfaDate,
  formatPfaDateMedium,
  formatPfaTime,
  formatPfaTime12h,
} from "@/lib/timezone";
import { ConfirmDialog } from "@/app/_components/confirm-dialog";

export type BlockEditInitialValues = {
  id: string;
  resourceId: string;
  startAt: Date;
  endAt: Date;
  reason: string;
  // BLOCK-RECUR: set when this block is an occurrence of a recurring series.
  seriesId?: string | null;
};

// Which removal the confirm dialog is about: a one-off block, a single
// occurrence of a series (records a skipDate), or the entire series.
type RemoveMode = "single" | "occurrence" | "series";

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
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const [state, formAction, pending] = useActionState(
    updateBlockFormAction,
    INITIAL_STATE,
  );
  const [deleting, setDeleting] = useState(false);
  const [removeMode, setRemoveMode] = useState<RemoveMode | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const isSeries = Boolean(initial?.seriesId);

  // This dialog is edit-only; an existing block always opens to the
  // read-only summary first (QA2-5), with an Edit button to reveal the
  // form. With no `initial` (defensive) we fall straight to the form.
  const isEdit = Boolean(initial);
  const [view, setView] = useState<"summary" | "edit">(
    isEdit ? "summary" : "edit",
  );
  // Reset the view on each (re)open via the adjust-during-render pattern
  // keyed on the open transition — NOT setState-in-effect (repo lint).
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setView(isEdit ? "summary" : "edit");
  }

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  // When entering the dialog in summary view, focus the Edit button.
  useEffect(() => {
    if (open && view === "summary") editButtonRef.current?.focus();
  }, [open, view]);

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

  const resourceName = useMemo(() => {
    if (!initial) return "";
    return (
      resources.find((r) => r.id === initial.resourceId)?.name ??
      initial.resourceId
    );
  }, [initial, resources]);

  const handleDelete = (mode: RemoveMode) => {
    if (!initial) return;
    setDeleteError(null);
    setRemoveMode(mode);
  };

  const handleConfirmDelete = async () => {
    if (!initial || !removeMode) return;
    setDeleteError(null);
    setDeleting(true);
    try {
      if (removeMode === "series" && initial.seriesId) {
        await deleteBlockSeries(initial.seriesId);
      } else if (removeMode === "occurrence") {
        // Records the date in the series' skipDates so an edit-regenerate
        // won't recreate it, then removes just this occurrence.
        await cancelBlockOccurrence(initial.id);
      } else {
        await deleteBlockAction(initial.id);
      }
      setRemoveMode(null);
      onClose();
    } catch {
      // Benign "already gone" (another admin removed it, or a transient
      // blip). Don't throw to the route boundary — re-sync and tell the
      // user the stale block is on its way out.
      setDeleteError("That block was already removed — refreshing.");
      router.refresh();
    } finally {
      setDeleting(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="m-auto w-full max-w-lg rounded-xl border border-line bg-surface text-fg p-0 shadow-[var(--shadow-lg)] backdrop:bg-page/70 backdrop:backdrop-blur-sm"
    >
      {view === "summary" && initial ? (
        <div className="space-y-5 p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.14em] text-fg-muted">
                Blocked time
              </p>
              <div className="flex items-center gap-2 mt-0.5">
                <h2 className="text-xl font-semibold tracking-tight">Block</h2>
                {isSeries ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-line-strong bg-surface-2 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-fg-muted">
                    <Repeat className="h-3 w-3" />
                    Recurring
                  </span>
                ) : null}
              </div>
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

          <dl className="space-y-3">
            <DetailRow label="Resource" value={resourceName} />
            <DetailRow
              label="Date"
              value={formatPfaDateMedium(initial.startAt)}
              tnum
            />
            <DetailRow
              label="Time"
              value={`${formatPfaTime12h(initial.startAt)} – ${formatPfaTime12h(initial.endAt)}`}
              tnum
            />
            <DetailRow label="Reason" value={initial.reason} />
          </dl>

          <div className="flex items-center justify-between gap-2 pt-2">
            <RemovalButtons
              isSeries={isSeries}
              deleting={deleting}
              onRemove={handleDelete}
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-line bg-surface-2 text-fg-muted hover:text-fg hover:border-line-strong h-9 px-4 text-sm font-medium transition-colors"
              >
                Close
              </button>
              <button
                ref={editButtonRef}
                type="button"
                onClick={() => setView("edit")}
                className="inline-flex items-center gap-1.5 rounded-md bg-gold text-gold-ink shadow-[var(--shadow-sm)] hover:bg-gold-hover h-9 px-4 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
              >
                <Pencil className="h-4 w-4" />
                Edit
              </button>
            </div>
          </div>
        </div>
      ) : (
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
          <RemovalButtons
            isSeries={isSeries}
            deleting={deleting}
            disabled={pending}
            onRemove={handleDelete}
          />
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
      )}

      <ConfirmDialog
        open={removeMode !== null}
        onOpenChange={(next) => {
          if (!deleting) {
            if (!next) {
              setRemoveMode(null);
              setDeleteError(null);
            }
          }
        }}
        title={
          removeMode === "series"
            ? "Delete the entire recurring block?"
            : removeMode === "occurrence"
              ? "Remove this occurrence?"
              : "Delete this block?"
        }
        description={
          <>
            {initial
              ? removeMode === "series"
                ? `This removes EVERY occurrence of "${initial.reason}" (past and future). This can't be undone.`
                : `"${initial.reason}" · ${formatPfaDateMedium(initial.startAt)} · ${formatPfaTime(initial.startAt)} – ${formatPfaTime(initial.endAt)}. This can't be undone.`
              : null}
            {deleteError ? (
              <span role="alert" className="mt-2 block text-danger">
                {deleteError}
              </span>
            ) : null}
          </>
        }
        confirmLabel={
          deleting
            ? "Removing…"
            : removeMode === "series"
              ? "Delete series"
              : removeMode === "occurrence"
                ? "Remove occurrence"
                : "Delete block"
        }
        onConfirm={handleConfirmDelete}
        isPending={deleting}
      />
    </dialog>
  );
}

// Removal affordance(s). A one-off block gets a single "Delete block". A
// recurring occurrence gets two: "Remove this occurrence" (records a skipDate)
// and "Delete series" (all occurrences).
function RemovalButtons({
  isSeries,
  deleting,
  disabled = false,
  onRemove,
}: {
  isSeries: boolean;
  deleting: boolean;
  disabled?: boolean;
  onRemove: (mode: RemoveMode) => void;
}) {
  const busy = deleting || disabled;
  if (!isSeries) {
    return (
      <button
        type="button"
        onClick={() => onRemove("single")}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-md border border-danger/30 bg-danger/10 text-danger hover:bg-danger/20 h-9 px-3 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 transition-colors"
      >
        <Trash2 className="h-4 w-4" />
        {deleting ? "Deleting…" : "Delete block"}
      </button>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => onRemove("occurrence")}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-md border border-line-strong bg-surface-2 text-fg-muted hover:text-fg h-9 px-3 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
      >
        Remove this one
      </button>
      <button
        type="button"
        onClick={() => onRemove("series")}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-md border border-danger/30 bg-danger/10 text-danger hover:bg-danger/20 h-9 px-3 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 transition-colors"
      >
        <Trash2 className="h-4 w-4" />
        Delete series
      </button>
    </div>
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

// Read-only label/value row for the summary view (QA2-5).
function DetailRow({
  label,
  value,
  tnum,
}: {
  label: string;
  value: string;
  tnum?: boolean;
}) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-3 items-baseline">
      <dt className="text-xs uppercase tracking-wider text-fg-muted">
        {label}
      </dt>
      <dd className={`text-sm text-fg ${tnum ? "tnum" : ""}`}>{value}</dd>
    </div>
  );
}

const inputStyles =
  "w-full rounded-md bg-page border border-line text-fg placeholder:text-fg-subtle px-3 py-2 text-sm focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40";
const selectStyles = `${inputStyles} appearance-none pr-8`;

// Inputs render PFA wall-clock — same value regardless of viewer's browser TZ.
const toDateInput = formatPfaDate;
const toTimeInput = formatPfaTime;
