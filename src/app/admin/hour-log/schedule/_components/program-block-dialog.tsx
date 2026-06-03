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
import { ChevronLeft, Pencil, Repeat, Trash2, X } from "lucide-react";
import {
  cancelSeriesOccurrenceAction,
  createProgramScheduleBlockFormAction,
  deleteProgramScheduleBlockAction,
  editProgramScheduleSeriesFormAction,
  updateProgramScheduleBlockFormAction,
  type ProgramScheduleActionResult,
} from "../form-actions";
import { TimeSelect } from "@/app/_components/time-select";
import { DateInput } from "@/app/_components/date-input";
import { ConfirmDialog } from "@/app/_components/confirm-dialog";
import type { BlockReconciliation } from "@/lib/server/reconciliation";
import {
  formatPfaDate,
  formatPfaDateMedium,
  formatPfaTime,
  formatPfaTime12h,
  formatPfaWeekday,
  parsePfaInput,
} from "@/lib/timezone";

// Day pills for the recurring CREATE path (RECUR-b1). 0=Sun..6=Sat,
// matching createProgramScheduleSeriesSchema / generateOccurrences.
const WEEKDAY_PILLS: { value: number; label: string }[] = [
  { value: 0, label: "Sun" },
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
];

// PFA-local weekday (0=Sun..6=Sat) of the grid's selected date, derived
// from formatPfaWeekday's three-letter name so it never drifts with the
// runtime TZ.
function pfaWeekdayIndex(d: Date): number {
  const short = formatPfaWeekday(d);
  const idx = WEEKDAY_PILLS.findIndex((p) => p.label === short);
  return idx >= 0 ? idx : 0;
}

// RECUR-b2: medium label ("Aug 30, 2026") for a "YYYY-MM-DD" series date.
// Parses at noon PFA-local so the day never shifts across a DST/TZ edge,
// then reuses the shared medium formatter.
function formatIsoDateMedium(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  return formatPfaDateMedium(parsePfaInput(iso, "12:00"));
}

// RECUR-b2: "Mon, Wed" short weekday names for a daysOfWeek set, in
// Sun→Sat order via the existing WEEKDAY_PILLS labels.
function formatWeekdayList(days: number[]): string {
  const set = new Set(days);
  return WEEKDAY_PILLS.filter((p) => set.has(p.value))
    .map((p) => p.label)
    .join(", ");
}

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
  // RECUR-b2: NULL for one-off blocks; the parent series id for a series
  // occurrence (branches the summary into series-aware actions).
  seriesId: string | null;
};

// RECUR-b2: the editable definition of a recurring series, prefilling the
// "Edit series" form. daysOfWeek = 0=Sun..6=Sat; startTime/endTime are
// "HH:MM"; startsOn/endsOn are "YYYY-MM-DD".
export type SeriesView = {
  id: string;
  programId: string;
  scheduledCoachId: string;
  daysOfWeek: number[];
  startTime: string;
  endTime: string;
  startsOn: string;
  endsOn: string;
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
  editSeriesInitial,
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
  editSeriesInitial?: SeriesView | null;
  reconciliation?: BlockReconciliation | null;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const isEdit = mode === "edit";
  // RECUR-b2: this edit targets a recurring-series occurrence (vs a one-off
  // block). Drives the summary branch + enables the "Edit series" view.
  const isSeries = Boolean(editInitial?.seriesId && editSeriesInitial);

  const [state, formAction, pending] = useActionState(
    isEdit
      ? updateProgramScheduleBlockFormAction
      : createProgramScheduleBlockFormAction,
    INITIAL_STATE,
  );
  // RECUR-b2: dedicated action state for the whole-series edit form. Lives
  // top-level/unconditionally (hooks rules); only consumed in the
  // "editSeries" view.
  const [seriesState, seriesFormAction, seriesPending] = useActionState(
    editProgramScheduleSeriesFormAction,
    INITIAL_STATE,
  );
  const [deleting, setDeleting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // RECUR-b2: "Cancel this occurrence" state (mirrors delete) + its own
  // confirm dialog + inline error.
  const [cancelling, setCancelling] = useState(false);
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  // Edit opens to a read-only summary first (QA2-5); create goes straight
  // to the form as before. RECUR-b2 adds the "editSeries" whole-series form.
  const [view, setView] = useState<"summary" | "edit" | "editSeries">(
    isEdit ? "summary" : "edit",
  );
  // Reset the view on each (re)open via adjust-during-render keyed on the
  // open transition — NOT setState-in-effect (repo lint).
  const [prevOpen, setPrevOpen] = useState(open);

  // RECUR-b1: create-recurring toggle + its fields. Default UNCHECKED so
  // the create form behaves exactly as before until the admin opts in.
  // selectedDays seeds with the grid's selected weekday; endsOn (ISO) is
  // the season-end DateInput value. Reset on each (re)open of the create
  // dialog (keyed on the open transition, NOT setState-in-effect).
  const selectedWeekday = useMemo(() => pfaWeekdayIndex(date), [date]);
  const [recurring, setRecurring] = useState(false);
  const [selectedDays, setSelectedDays] = useState<Set<number>>(
    () => new Set([selectedWeekday]),
  );
  const [endsOn, setEndsOn] = useState("");
  const [recurError, setRecurError] = useState<string | null>(null);

  // RECUR-b2: edit-series form state — weekday pills + season start/end
  // dates, seeded from the parent series. Kept separate from the create
  // path's state so neither clobbers the other. Reset on each (re)open.
  const [seriesDays, setSeriesDays] = useState<Set<number>>(
    () => new Set(editSeriesInitial?.daysOfWeek ?? []),
  );
  const [seriesStartsOn, setSeriesStartsOn] = useState(
    editSeriesInitial?.startsOn ?? "",
  );
  const [seriesEndsOn, setSeriesEndsOn] = useState(
    editSeriesInitial?.endsOn ?? "",
  );
  const [seriesError, setSeriesError] = useState<string | null>(null);

  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setView(isEdit ? "summary" : "edit");
      setRecurring(false);
      setSelectedDays(new Set([selectedWeekday]));
      setEndsOn("");
      setRecurError(null);
      setSeriesDays(new Set(editSeriesInitial?.daysOfWeek ?? []));
      setSeriesStartsOn(editSeriesInitial?.startsOn ?? "");
      setSeriesEndsOn(editSeriesInitial?.endsOn ?? "");
      setSeriesError(null);
      setCancelError(null);
    }
  }

  const toggleDay = (value: number) => {
    setRecurError(null);
    setSelectedDays((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  };

  const toggleSeriesDay = (value: number) => {
    setSeriesError(null);
    setSeriesDays((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  };

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

  // Auto-close after a successful submit.
  const wasPending = useRef(false);
  useEffect(() => {
    if (wasPending.current && !pending && state.ok && open) onClose();
    wasPending.current = pending;
  }, [pending, state, open, onClose]);

  // RECUR-b2: same auto-close pattern for the whole-series edit form. Its
  // own pending/state refs keep it independent from the block form effect.
  const seriesWasPending = useRef(false);
  useEffect(() => {
    if (seriesWasPending.current && !seriesPending && seriesState.ok && open)
      onClose();
    seriesWasPending.current = seriesPending;
  }, [seriesPending, seriesState, open, onClose]);

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

  const programName = useMemo(() => {
    if (!editInitial) return "";
    return (
      programs.find((p) => p.id === editInitial.programId)?.name ??
      editInitial.programId
    );
  }, [editInitial, programs]);

  const coachName = useMemo(() => {
    if (!editInitial) return "";
    const coach = coaches.find((c) => c.id === editInitial.scheduledCoachId);
    return coach ? (coach.name ?? coach.email) : editInitial.scheduledCoachId;
  }, [editInitial, coaches]);

  // RECUR-b2: prefill values for the edit-series form. On an errored submit
  // echo what was submitted; otherwise seed from the parent series.
  const seriesDefaults = useMemo(() => {
    if (!seriesState.ok && seriesState.values) {
      return {
        programId: seriesState.values.programId,
        scheduledCoachId: seriesState.values.scheduledCoachId,
        startTime: seriesState.values.startTime,
        endTime: seriesState.values.endTime,
        note: seriesState.values.note,
      };
    }
    if (editSeriesInitial) {
      return {
        programId: editSeriesInitial.programId,
        scheduledCoachId: editSeriesInitial.scheduledCoachId,
        startTime: editSeriesInitial.startTime,
        endTime: editSeriesInitial.endTime,
        note: editSeriesInitial.note ?? "",
      };
    }
    return {
      programId: "",
      scheduledCoachId: "",
      startTime: "09:00",
      endTime: "10:00",
      note: "",
    };
  }, [editSeriesInitial, seriesState]);

  // Recurrence summary line for a series occurrence, e.g.
  // "Repeats Mon, Wed · through Aug 30, 2026".
  const recurrenceLine = useMemo(() => {
    if (!editSeriesInitial) return "";
    const days = formatWeekdayList(editSeriesInitial.daysOfWeek);
    return `Repeats ${days} · through ${formatIsoDateMedium(editSeriesInitial.endsOn)}`;
  }, [editSeriesInitial]);

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

  // RECUR-b2: cancel just THIS occurrence (mirrors delete). On success →
  // close; on typed error → inline alert in the summary.
  const handleCancelOccurrence = () => {
    if (!editInitial) return;
    setCancelError(null);
    setCancelConfirmOpen(true);
  };

  const handleConfirmCancelOccurrence = async () => {
    if (!editInitial) return;
    setCancelling(true);
    try {
      const result = await cancelSeriesOccurrenceAction(editInitial.id);
      if (result.ok) {
        setCancelConfirmOpen(false);
        onClose();
      } else {
        setCancelError(result.error.message);
        setCancelConfirmOpen(false);
      }
    } finally {
      setCancelling(false);
    }
  };

  // Key remounts the inputs when switching between blocks / modes and
  // re-populates submitted values on error.
  const formKey = state.ok
    ? `psb-${mode}-${editInitial?.id ?? createPrefill?.programId ?? "none"}-${defaults.startTime}`
    : `psb-err-${state.error.code}-${state.error.message}`;

  // RECUR-b2: separate key for the series form so an errored submit
  // re-seeds its echoed values, and a fresh open re-seeds from the series.
  const seriesFormKey = seriesState.ok
    ? `pss-${editSeriesInitial?.id ?? "none"}`
    : `pss-err-${seriesState.error.code}-${seriesState.error.message}`;

  return (
    <dialog
      ref={dialogRef}
      className="m-auto w-full max-w-lg rounded-xl border border-line bg-surface text-fg p-0 shadow-[var(--shadow-lg)] backdrop:bg-page/70 backdrop:backdrop-blur-sm"
    >
      {view === "summary" && editInitial ? (
        <div className="space-y-5 p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <p className="text-xs uppercase tracking-[0.14em] text-fg-muted">
                  Edit
                </p>
                {isSeries ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-gold/40 bg-gold/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-gold-strong">
                    <Repeat className="h-3 w-3" />
                    Recurring
                  </span>
                ) : null}
              </div>
              <h2 className="text-xl font-semibold tracking-tight mt-0.5">
                Program block
              </h2>
              {isSeries && recurrenceLine ? (
                <p className="text-xs text-fg-muted mt-1">{recurrenceLine}</p>
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

          {deleteError ? (
            <div
              role="alert"
              className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
            >
              {deleteError}
            </div>
          ) : null}

          {cancelError ? (
            <div
              role="alert"
              className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
            >
              {cancelError}
            </div>
          ) : null}

          {reconciliation ? (
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

          <dl className="space-y-3">
            <DetailRow label="Program" value={programName} />
            <DetailRow label="Coach" value={coachName} />
            <DetailRow
              label="Date"
              value={formatPfaDateMedium(editInitial.startAt)}
              tnum
            />
            <DetailRow
              label="Time"
              value={`${formatPfaTime12h(editInitial.startAt)} – ${formatPfaTime12h(editInitial.endAt)}`}
              tnum
            />
            <DetailRow label="Note" value={editInitial.note ?? "—"} />
          </dl>

          <div className="flex items-center justify-between gap-2 pt-2">
            {isSeries ? (
              <button
                type="button"
                onClick={handleCancelOccurrence}
                disabled={cancelling}
                className="inline-flex items-center gap-1.5 rounded-md border border-danger/30 bg-danger/10 text-danger hover:bg-danger/20 h-9 px-3 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 transition-colors"
              >
                <Trash2 className="h-4 w-4" />
                {cancelling ? "Cancelling…" : "Cancel this occurrence"}
              </button>
            ) : (
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleting}
                className="inline-flex items-center gap-1.5 rounded-md border border-danger/30 bg-danger/10 text-danger hover:bg-danger/20 h-9 px-3 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 transition-colors"
              >
                <Trash2 className="h-4 w-4" />
                {deleting ? "Deleting…" : "Delete block"}
              </button>
            )}
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
                onClick={() => setView(isSeries ? "editSeries" : "edit")}
                className="inline-flex items-center gap-1.5 rounded-md bg-gold text-gold-ink shadow-[var(--shadow-sm)] hover:bg-gold-hover h-9 px-4 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
              >
                <Pencil className="h-4 w-4" />
                {isSeries ? "Edit series" : "Edit"}
              </button>
            </div>
          </div>
        </div>
      ) : view === "editSeries" && editSeriesInitial ? (
        <form
          action={seriesFormAction}
          key={seriesFormKey}
          onSubmit={(e) => {
            // Client guard: at least one weekday must be checked. Server
            // schema is still the source of truth.
            if (seriesDays.size === 0) {
              e.preventDefault();
              setSeriesError("Pick at least one weekday.");
            }
          }}
          className="space-y-5 p-6"
        >
          <input
            type="hidden"
            name="seriesId"
            defaultValue={editSeriesInitial.id}
          />

          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.14em] text-fg-muted">
                Edit series
              </p>
              <h2 className="text-xl font-semibold tracking-tight mt-0.5">
                Recurring program block
              </h2>
              <p className="text-xs text-fg-muted mt-1">
                Saving updates the whole series and regenerates future dates.
              </p>
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

          {!seriesState.ok ? (
            <div
              role="alert"
              className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
            >
              {seriesState.error.message}
            </div>
          ) : null}

          <div className="space-y-3">
            <Field label="Program">
              <select
                name="programId"
                required
                defaultValue={seriesDefaults.programId}
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
                defaultValue={seriesDefaults.scheduledCoachId}
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
                  defaultValue={seriesDefaults.startTime}
                  className={selectStyles}
                />
              </Field>
              <Field label="End">
                <TimeSelect
                  name="endTime"
                  variant="end"
                  required
                  defaultValue={seriesDefaults.endTime}
                  className={selectStyles}
                />
              </Field>
            </div>

            <div>
              <span className="text-xs uppercase tracking-wider text-fg-muted block mb-1.5">
                Repeat on
              </span>
              <div
                role="group"
                aria-label="Repeat on"
                className="flex flex-wrap gap-1.5"
              >
                {WEEKDAY_PILLS.map((d) => {
                  const active = seriesDays.has(d.value);
                  return (
                    <label
                      key={d.value}
                      className={`inline-flex items-center justify-center h-8 min-w-[2.75rem] px-2.5 rounded-md border text-xs font-medium cursor-pointer select-none transition-colors focus-within:outline-none focus-within:ring-2 focus-within:ring-gold/40 ${
                        active
                          ? "bg-gold/10 border-gold/40 text-gold-strong"
                          : "border-line text-fg-muted hover:text-fg hover:border-line-strong"
                      }`}
                    >
                      <input
                        type="checkbox"
                        name="daysOfWeek"
                        value={d.value}
                        checked={active}
                        onChange={() => toggleSeriesDay(d.value)}
                        className="sr-only"
                      />
                      {d.label}
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Season starts on">
                <DateInput
                  name="startsOn"
                  value={seriesStartsOn}
                  onChange={(iso) => {
                    setSeriesStartsOn(iso);
                    setSeriesError(null);
                  }}
                  required
                  aria-label="Season starts on"
                />
              </Field>
              <Field label="Season ends on">
                <DateInput
                  name="endsOn"
                  value={seriesEndsOn}
                  onChange={(iso) => {
                    setSeriesEndsOn(iso);
                    setSeriesError(null);
                  }}
                  required
                  aria-label="Season ends on"
                />
              </Field>
            </div>

            {seriesError ? (
              <p
                role="alert"
                className="text-[11px] text-danger leading-snug"
              >
                {seriesError}
              </p>
            ) : null}

            <Field
              label="Note"
              hint="Optional — e.g. 'Bring radar gun', context for the coach."
            >
              <input
                type="text"
                name="note"
                maxLength={200}
                defaultValue={seriesDefaults.note}
                className={inputStyles}
              />
            </Field>
          </div>

          <div className="flex items-center justify-between gap-2 pt-2">
            <button
              type="button"
              onClick={() => setView("summary")}
              disabled={seriesPending}
              className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-2 text-fg-muted hover:text-fg hover:border-line-strong h-9 px-3 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronLeft className="h-4 w-4" />
              Back
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
                disabled={seriesPending}
                className="rounded-md bg-gold text-gold-ink shadow-[var(--shadow-sm)] hover:bg-gold-hover h-9 px-4 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
              >
                {seriesPending ? "Saving…" : "Save series"}
              </button>
            </div>
          </div>
        </form>
      ) : (
      <form
        action={formAction}
        key={formKey}
        onSubmit={(e) => {
          // Client guard for the recurring path: at least one weekday must
          // be checked. The server schema is still the source of truth, but
          // this gives an immediate inline message. endsOn `required` on the
          // DateInput blocks an empty season-end via native validation.
          if (!isEdit && recurring && selectedDays.size === 0) {
            e.preventDefault();
            setRecurError("Pick at least one weekday.");
          }
        }}
        className="space-y-5 p-6"
      >
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

          {!isEdit ? (
            <div className="space-y-3">
              <label className="flex items-center gap-2.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  name="recurring"
                  checked={recurring}
                  onChange={(e) => {
                    setRecurring(e.target.checked);
                    setRecurError(null);
                  }}
                  className="h-4 w-4 rounded border-line text-gold accent-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
                />
                <span className="text-sm text-fg">Repeats weekly</span>
              </label>

              {recurring ? (
                <div className="space-y-3 rounded-md border border-line bg-surface-2/40 p-3">
                  <div>
                    <span className="text-xs uppercase tracking-wider text-fg-muted block mb-1.5">
                      Repeat on
                    </span>
                    <div
                      role="group"
                      aria-label="Repeat on"
                      className="flex flex-wrap gap-1.5"
                    >
                      {WEEKDAY_PILLS.map((d) => {
                        const active = selectedDays.has(d.value);
                        return (
                          <label
                            key={d.value}
                            className={`inline-flex items-center justify-center h-8 min-w-[2.75rem] px-2.5 rounded-md border text-xs font-medium cursor-pointer select-none transition-colors focus-within:outline-none focus-within:ring-2 focus-within:ring-gold/40 ${
                              active
                                ? "bg-gold/10 border-gold/40 text-gold-strong"
                                : "border-line text-fg-muted hover:text-fg hover:border-line-strong"
                            }`}
                          >
                            <input
                              type="checkbox"
                              name="daysOfWeek"
                              value={d.value}
                              checked={active}
                              onChange={() => toggleDay(d.value)}
                              className="sr-only"
                            />
                            {d.label}
                          </label>
                        );
                      })}
                    </div>
                  </div>

                  <Field
                    label="Season ends on"
                    hint="Repeats every chosen day through this date."
                  >
                    <DateInput
                      name="endsOn"
                      value={endsOn}
                      onChange={(iso) => {
                        setEndsOn(iso);
                        setRecurError(null);
                      }}
                      required
                      aria-label="Season ends on"
                    />
                  </Field>

                  <p className="text-[11px] text-fg-subtle leading-snug">
                    Creates a block on each chosen day from{" "}
                    {formatPfaDateMedium(date)} through the end date.
                  </p>

                  {recurError ? (
                    <p
                      role="alert"
                      className="text-[11px] text-danger leading-snug"
                    >
                      {recurError}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

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
                  : recurring
                    ? "Schedule series"
                    : "Schedule block"}
            </button>
          </div>
        </div>
      </form>
      )}

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

      <ConfirmDialog
        open={cancelConfirmOpen}
        onOpenChange={(next) => {
          if (!cancelling) setCancelConfirmOpen(next);
        }}
        title="Cancel this occurrence?"
        description={
          editInitial
            ? `Cancel the ${formatPfaDateMedium(editInitial.startAt)} occurrence? Other dates in the series are unaffected.`
            : undefined
        }
        confirmLabel={cancelling ? "Cancelling…" : "Cancel occurrence"}
        onConfirm={handleConfirmCancelOccurrence}
        isPending={cancelling}
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
