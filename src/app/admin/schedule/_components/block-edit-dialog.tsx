"use client";

// Click-an-existing-block flow. Mirrors SessionFormDialog's edit
// surface but for blocked_times rows. Delete lives inside the dialog
// (per the H1 click-UX call) rather than as a separate click affordance
// on the grid — single mental model: click anything → edit it.
//
// Create-side blocks still go through ScheduleCreateDialog's Block
// tab; this component is edit-only.

import {
  useActionState,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type FormEvent,
} from "react";
import { useRouter } from "next/navigation";
import { Pencil, Repeat, Trash2, X } from "lucide-react";
import {
  deleteBlockAction,
  updateBlockFormAction,
  type BlockActionResult,
} from "../form-actions";
import {
  cancelBlockOccurrence,
  deleteBlockSeries,
  editBlockSeries,
  getBlockSeries,
} from "../actions";
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
import { CagePicker } from "./cage-picker";
import { RepeatsUntilPresets } from "./repeats-until-presets";
import { BlockSkipReport } from "./block-skip-report";
import {
  FREQUENCY_OPTIONS,
  freqIntervalForKind,
  kindForFreqInterval,
  monthlyHint,
  weekdayFromIso,
  type FrequencyKind,
} from "@/app/admin/hour-log/schedule/_components/recurrence-frequency.logic";
import type { BlockSeriesResult } from "@/lib/server/block-series-actions";

// The series pattern the "Apply to all" form seeds from — the getBlockSeries
// read-action's return shape. Fetched lazily when the admin first ticks the
// toggle (never on plain dialog open).
type SeriesPattern = {
  id: string;
  resourceIds: string[];
  reason: string;
  daysOfWeek: number[];
  frequency: "weekly" | "monthly";
  interval: number;
  startTime: string;
  endTime: string;
  startsOn: string;
  endsOn: string;
};

// Weekday pills for the series-edit recurrence controls. Mirrors the create
// dialog's local `{ i, label }` pill shape (Sun=0 .. Sat=6, getUTCDay order).
const WEEKDAY_PILLS = [
  { i: 0, label: "S" },
  { i: 1, label: "M" },
  { i: 2, label: "T" },
  { i: 3, label: "W" },
  { i: 4, label: "T" },
  { i: 5, label: "F" },
  { i: 6, label: "S" },
] as const;

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

  // "Apply to all in this recurring series" toggle (default UNCHECKED —
  // single-occurrence edit). When ticked, we lazily fetch the series' pattern
  // (getBlockSeries) and reveal the series-edit form seeded from it.
  const [applyToSeries, setApplyToSeries] = useState(false);
  const [seriesPattern, setSeriesPattern] = useState<SeriesPattern | null>(
    null,
  );
  const [seriesLoading, setSeriesLoading] = useState(false);
  const [seriesLoadError, setSeriesLoadError] = useState<string | null>(null);

  // Lazy-fetch the series pattern the first time the admin ticks the toggle.
  // A plain async handler triggered by the checkbox onChange — NOT a setState-
  // in-an-open-transition-effect (which the repo's lint forbids). Cached across
  // toggles once loaded (keyed on the current seriesId).
  const handleToggleSeries = async (checked: boolean) => {
    setApplyToSeries(checked);
    if (!checked) return;
    if (!initial?.seriesId) return;
    if (seriesPattern && seriesPattern.id === initial.seriesId) return;
    setSeriesLoadError(null);
    setSeriesLoading(true);
    try {
      const pattern = await getBlockSeries(initial.seriesId);
      if (!pattern) {
        setSeriesLoadError("That series was already removed — refreshing.");
        router.refresh();
        return;
      }
      setSeriesPattern(pattern);
    } catch {
      setSeriesLoadError("Couldn't load the series settings — try again.");
    } finally {
      setSeriesLoading(false);
    }
  };

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
    if (open) {
      setView(isEdit ? "summary" : "edit");
      // Reset the series-edit toggle + its fetched pattern on each (re)open so
      // opening a different block doesn't inherit the prior one's series state.
      setApplyToSeries(false);
      setSeriesPattern(null);
      setSeriesLoading(false);
      setSeriesLoadError(null);
    }
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
      className="m-auto w-full max-w-lg rounded-xl border border-line bg-surface text-fg p-0 shadow-[var(--shadow-lg)] backdrop:bg-page/30"
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
      ) : applyToSeries && isSeries && initial ? (
        // ── "Apply to all" series-edit mode ────────────────────────────────
        <div className="space-y-5 p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <p className="text-xs uppercase tracking-[0.14em] text-fg-muted">
                  Edit
                </p>
                <span className="inline-flex items-center gap-1 rounded-full border border-line-strong bg-surface-2 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-fg-muted">
                  <Repeat className="h-3 w-3" />
                  Recurring
                </span>
              </div>
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

          <SeriesToggle
            checked={applyToSeries}
            onChange={handleToggleSeries}
          />

          {seriesLoadError ? (
            <div
              role="alert"
              className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
            >
              {seriesLoadError}
            </div>
          ) : null}

          {seriesLoading || !seriesPattern ? (
            <p className="text-sm text-fg-muted">Loading series settings…</p>
          ) : (
            <SeriesEditForm
              key={seriesPattern.id}
              pattern={seriesPattern}
              resources={resources}
              onClose={onClose}
            />
          )}
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

        {isSeries ? (
          <SeriesToggle checked={applyToSeries} onChange={handleToggleSeries} />
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

// "Apply to all in this recurring series" toggle. Mirrors the work-log program
// dialog's copy exactly. Unchecked → single-occurrence edit; checked → the
// series-edit form (seeded lazily from getBlockSeries).
function SeriesToggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="rounded-md border border-line bg-surface-2/40 px-3 py-2.5">
      <label className="flex items-center gap-2.5 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 rounded border-line text-gold accent-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
        />
        <span className="text-sm text-fg">
          Apply to all in this recurring series
        </span>
      </label>
      <p className="text-[11px] text-fg-subtle mt-1 ml-[1.625rem] leading-snug">
        Unchecked changes only this occurrence.
      </p>
    </div>
  );
}

// Series-edit form: cages / reason / start-end time / recurrence controls,
// seeded from the series' pattern. Submits via a client transition (mirrors
// ScheduleCreateDialog's BlockTab + this dialog's direct action calls) rather
// than a form action, to avoid the useActionState action-swap race. On a clean
// save (nothing skipped) it closes; any skip keeps it open with a report.
function SeriesEditForm({
  pattern,
  resources,
  onClose,
}: {
  pattern: SeriesPattern;
  resources: ResourceOption[];
  onClose: () => void;
}) {
  const [resourceIds, setResourceIds] = useState<string[]>(
    pattern.resourceIds,
  );
  const [reason, setReason] = useState(pattern.reason);
  const [startTime, setStartTime] = useState(pattern.startTime);
  const [endTime, setEndTime] = useState(pattern.endTime);
  const [startsOn, setStartsOn] = useState(pattern.startsOn);
  const [endsOn, setEndsOn] = useState(pattern.endsOn);
  const [freqKind, setFreqKind] = useState<FrequencyKind>(() =>
    kindForFreqInterval(pattern.frequency, pattern.interval),
  );
  const [everyN, setEveryN] = useState(() =>
    pattern.frequency === "weekly" && pattern.interval >= 3
      ? pattern.interval
      : 3,
  );
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>(pattern.daysOfWeek);

  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BlockSeriesResult | null>(null);

  const { frequency, interval } = freqIntervalForKind(freqKind, everyN);
  const isMonthly = frequency === "monthly";
  // Monthly derives its weekday from the season-start date (same convention as
  // the create + program dialogs). Fall back to the stored days otherwise.
  const monthlyWeekday = weekdayFromIso(startsOn);
  const submitDays =
    isMonthly && monthlyWeekday !== null ? [monthlyWeekday] : daysOfWeek;

  const toggleResource = (id: string) => {
    setError(null);
    setResourceIds((prev) =>
      prev.includes(id) ? prev.filter((r) => r !== id) : [...prev, id],
    );
  };

  const toggleDay = (i: number) => {
    setError(null);
    setDaysOfWeek((prev) =>
      prev.includes(i) ? prev.filter((d) => d !== i) : [...prev, i].sort(),
    );
  };

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return; // guard the Enter key / double-submit race
    setError(null);
    if (resourceIds.length === 0) {
      setError("Pick at least one cage.");
      return;
    }
    if (!reason.trim()) {
      setError("Enter a reason.");
      return;
    }
    if (!startTime || !endTime) {
      setError("Pick a time.");
      return;
    }
    if (startTime >= endTime) {
      setError("Start must be before end.");
      return;
    }
    if (!startsOn) {
      setError("Pick a 'starts' date.");
      return;
    }
    if (!endsOn) {
      setError("Pick a 'repeats until' date.");
      return;
    }
    if (submitDays.length === 0) {
      setError("Pick at least one weekday.");
      return;
    }

    startTransition(async () => {
      try {
        const res = await editBlockSeries(pattern.id, {
          resourceIds,
          reason: reason.trim(),
          daysOfWeek: submitDays,
          startTime,
          endTime,
          startsOn,
          endsOn,
          frequency,
          interval,
        });
        setResult(res);
        // Clean save (nothing skipped) → close; the server revalidate refreshes
        // the grid. Any skip keeps the dialog open so the report shows.
        if (res.skippedRentals.length === 0 && res.skippedBlocked.length === 0) {
          onClose();
        }
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to update the series.",
        );
      }
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {error ? (
        <div
          role="alert"
          className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
        >
          {error}
        </div>
      ) : null}

      <CagePicker
        resources={resources}
        selected={resourceIds}
        onToggle={toggleResource}
      />

      <Field
        label="Reason"
        hint="Free text — e.g. 'Summer Camp Group 5', 'HVAC repair'."
      >
        <input
          type="text"
          required
          maxLength={120}
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            setError(null);
          }}
          placeholder="What's this block for?"
          className={inputStyles}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Start">
          <TimeSelect
            name="startTime"
            variant="start"
            required
            value={startTime}
            onChange={(v) => {
              setStartTime(v);
              setError(null);
            }}
            className={selectStyles}
          />
        </Field>
        <Field label="End">
          <TimeSelect
            name="endTime"
            variant="end"
            required
            value={endTime}
            onChange={(v) => {
              setEndTime(v);
              setError(null);
            }}
            className={selectStyles}
          />
        </Field>
      </div>

      <div className="rounded-lg border border-line bg-page/50 p-3.5 space-y-3">
        <Field label="Frequency">
          <select
            value={freqKind}
            onChange={(e) => {
              setFreqKind(e.target.value as FrequencyKind);
              setError(null);
            }}
            className={selectStyles}
          >
            {FREQUENCY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>

        {freqKind === "everyN" ? (
          <Field label="Every N weeks">
            <input
              type="number"
              min={1}
              value={everyN}
              onChange={(e) => {
                const n = Number(e.target.value);
                setEveryN(Number.isFinite(n) && n >= 1 ? n : 1);
                setError(null);
              }}
              className={inputStyles}
            />
          </Field>
        ) : null}

        {isMonthly ? (
          <p className="text-xs text-fg-muted">
            {monthlyHint(startsOn) || "Pick a start date to set the pattern."}
          </p>
        ) : (
          <div>
            <span className="block text-xs uppercase tracking-wider text-fg-muted mb-1.5">
              On these days
            </span>
            <div className="flex gap-1.5">
              {WEEKDAY_PILLS.map((d) => {
                const on = submitDays.includes(d.i);
                return (
                  <button
                    key={d.i}
                    type="button"
                    onClick={() => toggleDay(d.i)}
                    aria-pressed={on}
                    className={[
                      "h-8 w-8 rounded-full text-xs font-semibold transition-colors",
                      on
                        ? "bg-gold text-gold-ink"
                        : "border border-line text-fg-muted hover:text-fg hover:border-line-strong",
                    ].join(" ")}
                  >
                    {d.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Starts">
            <DateInput
              required
              value={startsOn}
              onChange={(iso) => {
                setStartsOn(iso);
                setError(null);
              }}
              className={inputStyles}
            />
          </Field>
          <Field
            label="Repeats until"
            hint="Last date the block can occur (inclusive)."
          >
            <RepeatsUntilPresets
              startsOn={startsOn}
              endsOn={endsOn}
              onEndsOnChange={(iso) => {
                setEndsOn(iso);
                setError(null);
              }}
              dateInputClassName={inputStyles}
            />
          </Field>
        </div>
      </div>

      {result ? <SeriesReport result={result} /> : null}

      {result ? (
        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-gold text-gold-ink shadow-[var(--shadow-sm)] hover:bg-gold-hover h-9 px-4 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
          >
            Done
          </button>
        </div>
      ) : (
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
            className="rounded-md bg-gold text-gold-ink shadow-[var(--shadow-sm)] hover:bg-gold-hover h-9 px-4 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
          >
            {pending ? "Saving…" : "Save series"}
          </button>
        </div>
      )}
    </form>
  );
}

// Skip-and-continue report after a series edit — the future-regenerate result.
// Mirrors ScheduleCreateDialog's BlockReport presentation.
function SeriesReport({ result }: { result: BlockSeriesResult }) {
  return <BlockSkipReport result={result} />;
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
