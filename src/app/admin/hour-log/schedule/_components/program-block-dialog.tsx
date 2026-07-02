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
import { Pencil, Plus, Repeat, Trash2, X } from "lucide-react";
import {
  cancelSeriesOccurrenceAction,
  deleteProgramScheduleBlockAction,
  editProgramScheduleSeriesFormAction,
  submitProgramScheduleBlockFormAction,
  type ProgramScheduleActionResult,
} from "../form-actions";
import { TimeSelect } from "@/app/_components/time-select";
import { DateInput } from "@/app/_components/date-input";
import { RepeatsUntilPresets } from "@/app/admin/schedule/_components/repeats-until-presets";
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
import {
  FREQUENCY_OPTIONS,
  type FrequencyKind,
  freqIntervalForKind,
  kindForFreqInterval,
  monthlyHint,
  weekdayFromIso,
} from "./recurrence-frequency.logic";

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
// QA10 W3.3: a cage resource the admin can mark a program block as occupying.
export type ResourceOption = {
  id: string;
  name: string;
  type: "cage" | "bullpen" | "weight_room";
};

export type ProgramBlockEditInitial = {
  id: string;
  // QA-R2 #10: null when the block is Unassigned (no coach).
  programId: string;
  scheduledCoachId: string | null;
  // QA10 W3.2: the FULL scheduled-coach set (first = primary). The form
  // seeds its multi-coach control from this and submits scheduledCoachIds.
  // QA-R2 #10: EMPTY when the block has no coach.
  scheduledCoachIds: string[];
  startAt: Date;
  endAt: Date;
  note: string | null;
  // RECUR-b2: NULL for one-off blocks; the parent series id for a series
  // occurrence (branches the summary into series-aware actions).
  seriesId: string | null;
  // QA10 W3.3: the cage resources this block occupies (for edit prefill).
  resourceIds: string[];
};

// RECUR-b2: the editable definition of a recurring series, prefilling the
// "Edit series" form. daysOfWeek = 0=Sun..6=Sat; startTime/endTime are
// "HH:MM"; startsOn/endsOn are "YYYY-MM-DD".
export type SeriesView = {
  id: string;
  programId: string;
  // QA-R2 #10: null when the series has no coach.
  scheduledCoachId: string | null;
  // QA10 W3.2: full scheduled-coach set for the series (first = primary).
  // QA-R2 #10: EMPTY when the series has no coach.
  scheduledCoachIds: string[];
  daysOfWeek: number[];
  startTime: string;
  endTime: string;
  startsOn: string;
  endsOn: string;
  // QA10 W3.1b: recurrence pattern. "weekly" with interval N = every N
  // weeks; "monthly" with interval 1 = same weekday/ordinal each month.
  // The edit-series form prefills its frequency control from these.
  frequency: "weekly" | "monthly";
  interval: number;
  // QA10 W3.3: the cage resources every occurrence occupies (edit prefill).
  resourceIds: string[];
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

// QA10 W3.2: reconciliation banner. A single scheduled coach keeps today's
// one-line banner (aggregate status + detail). With multiple coaches it
// renders a per-coach breakdown — each coach's name + its own status label
// and detail, reusing RECON_STATUS_LABELS / reconBannerStyles per coach.
function ReconBanner({
  reconciliation,
}: {
  reconciliation: BlockReconciliation;
}) {
  if (reconciliation.coaches.length > 1) {
    return (
      <div role="status" className="space-y-1.5">
        {reconciliation.coaches.map((c) => (
          <div
            key={c.coachId}
            className={`rounded-md border px-3 py-2 text-xs ${reconBannerStyles(
              c.status,
            )}`}
          >
            <span className="font-medium uppercase tracking-wider">
              {c.coachName} · {RECON_STATUS_LABELS[c.status]}
            </span>
            <span className="block mt-0.5">{c.detail}</span>
          </div>
        ))}
      </div>
    );
  }
  return (
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
  );
}

export function ProgramBlockDialog({
  open,
  mode,
  onClose,
  date,
  programs,
  coaches,
  resources,
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
  // QA10 W3.3: active cage resources for the occupancy checkbox group.
  resources: ResourceOption[];
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
    submitProgramScheduleBlockFormAction,
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
  const [view, setView] = useState<"summary" | "edit">(
    isEdit ? "summary" : "edit",
  );
  // #10: when editing a recurring occurrence, the edit form defaults to
  // editing ONLY this occurrence. Ticking "Apply to all in this recurring
  // series" opts into a series-wide edit — it switches the form's action to
  // editProgramScheduleSeriesFormAction and reveals the series-level fields
  // (frequency/interval, weekday pills, season start/end). Default UNCHECKED.
  const [applyToSeries, setApplyToSeries] = useState(false);
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
  // QA10 W3.1b: recurrence pattern for the CREATE-recurring path. Default
  // "Every week" (→ weekly/interval 1) reproduces today's behavior. The
  // "Every N weeks" number lives in its own state, only read for that kind.
  const [freqKind, setFreqKind] = useState<FrequencyKind>("weekly");
  const [everyNWeeks, setEveryNWeeks] = useState(3);

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
  // QA10 W3.1b: recurrence pattern for the EDIT-series form, recovered from
  // the series' stored (frequency, interval) so the form opens on its
  // current pattern. Defaults to weekly/1 if a row predates the columns.
  const [seriesFreqKind, setSeriesFreqKind] = useState<FrequencyKind>(() =>
    kindForFreqInterval(
      editSeriesInitial?.frequency ?? "weekly",
      editSeriesInitial?.interval ?? 1,
    ),
  );
  const [seriesEveryNWeeks, setSeriesEveryNWeeks] = useState(() =>
    editSeriesInitial?.frequency === "weekly" &&
    (editSeriesInitial?.interval ?? 1) >= 3
      ? editSeriesInitial.interval
      : 3,
  );

  // QA10 W3.2: the multi-coach selection for the BLOCK form (create/edit)
  // and the SERIES form. Each is a list of selected coach ids; every
  // <select> submits name="scheduledCoachIds" so the action receives the
  // full set via getAll. Seed from the initial values on (re)open; create
  // starts with a single empty row. De-dupe is left to the action.
  // #10: the edit form's coach + resource controls always read the BLOCK
  // state — even for an apply-to-all (series) edit, which seeds from this
  // occurrence (its values belong to the series). So there's no separate
  // series coach/resource state; the series-error re-seed below writes here.
  const [blockCoachIds, setBlockCoachIds] = useState<string[]>(() =>
    isEdit && editInitial?.scheduledCoachIds?.length
      ? editInitial.scheduledCoachIds
      : [""],
  );

  // QA10 W3.3: occupied-resource selection for the BLOCK form (create/edit).
  // Controlled checkbox group; each checkbox submits name="resourceIds".
  // Seed from the initial values on (re)open; create starts empty (no
  // occupancy = today's behavior). Re-seed on errored submit so the admin's
  // selection survives the round-trip.
  const [blockResourceIds, setBlockResourceIds] = useState<string[]>(() =>
    isEdit ? (editInitial?.resourceIds ?? []) : [],
  );

  // The block's date is editable inline (was a fixed hidden field). Seeded
  // from the block's own date in edit, else the grid's selected date.
  const dateInput = formatPfaDate(date);
  const [formDate, setFormDate] = useState(dateInput);

  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setView(isEdit ? "summary" : "edit");
      setApplyToSeries(false);
      setRecurring(false);
      setSelectedDays(new Set([selectedWeekday]));
      setEndsOn("");
      setRecurError(null);
      setFreqKind("weekly");
      setEveryNWeeks(3);
      setSeriesDays(new Set(editSeriesInitial?.daysOfWeek ?? []));
      setSeriesStartsOn(editSeriesInitial?.startsOn ?? "");
      setSeriesEndsOn(editSeriesInitial?.endsOn ?? "");
      setSeriesError(null);
      setSeriesFreqKind(
        kindForFreqInterval(
          editSeriesInitial?.frequency ?? "weekly",
          editSeriesInitial?.interval ?? 1,
        ),
      );
      setSeriesEveryNWeeks(
        editSeriesInitial?.frequency === "weekly" &&
          (editSeriesInitial?.interval ?? 1) >= 3
          ? editSeriesInitial.interval
          : 3,
      );
      setBlockCoachIds(
        isEdit && editInitial?.scheduledCoachIds?.length
          ? editInitial.scheduledCoachIds
          : [""],
      );
      setBlockResourceIds(isEdit ? (editInitial?.resourceIds ?? []) : []);
      setFormDate(
        isEdit && editInitial ? formatPfaDate(editInitial.startAt) : dateInput,
      );
      setCancelError(null);
    }
  }

  // QA10 W3.2: on an errored block submit, re-seed the coach rows from the
  // submitted set so the admin's selection survives the round-trip. Tracked
  // via adjust-during-render keyed on the state object (NOT setState-in-
  // effect), mirroring the open-reset pattern above.
  const [prevState, setPrevState] = useState(state);
  if (state !== prevState) {
    setPrevState(state);
    if (!state.ok && state.values.scheduledCoachIds.length > 0) {
      setBlockCoachIds(state.values.scheduledCoachIds);
    }
    // QA10 W3.3: re-seed the occupancy selection from the submitted set.
    if (!state.ok) {
      setBlockResourceIds(state.values.resourceIds);
    }
    // Re-seed the chosen date so a failed submit keeps the chosen day.
    if (!state.ok) setFormDate(state.values.date);
  }
  // #10: an errored apply-to-all (series) submit re-seeds the SAME block
  // coach/resource controls the edit form renders, so the admin's selection
  // survives the round-trip. Same adjust-during-render pattern as above.
  const [prevSeriesState, setPrevSeriesState] = useState(seriesState);
  if (seriesState !== prevSeriesState) {
    setPrevSeriesState(seriesState);
    if (!seriesState.ok && seriesState.values.scheduledCoachIds.length > 0) {
      setBlockCoachIds(seriesState.values.scheduledCoachIds);
    }
    if (!seriesState.ok) {
      setBlockResourceIds(seriesState.values.resourceIds);
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

  // QA10 W3.2: mutators for the multi-coach controls. Passing the relevant
  // setter lets the same helpers serve both the block + series forms.
  const setCoachAt = (
    setter: React.Dispatch<React.SetStateAction<string[]>>,
    index: number,
    value: string,
  ) => {
    setter((prev) => prev.map((v, i) => (i === index ? value : v)));
  };
  const addCoachRow = (
    setter: React.Dispatch<React.SetStateAction<string[]>>,
  ) => {
    setter((prev) => [...prev, ""]);
  };
  const removeCoachRow = (
    setter: React.Dispatch<React.SetStateAction<string[]>>,
    index: number,
  ) => {
    setter((prev) =>
      prev.length > 1 ? prev.filter((_, i) => i !== index) : prev,
    );
  };

  // QA10 W3.3: toggle a resource in/out of an occupancy selection. The
  // setter targets either the block or the series resource state.
  const toggleResource = (
    setter: React.Dispatch<React.SetStateAction<string[]>>,
    resourceId: string,
  ) => {
    setter((prev) =>
      prev.includes(resourceId)
        ? prev.filter((id) => id !== resourceId)
        : [...prev, resourceId],
    );
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
  // empty skeleton. The date defaults to the grid's selected date but is
  // editable via the Date field (dateInput defined above).
  const defaults = useMemo(() => {
    // #10: when "apply to all" is on, an errored series submit echoes its
    // submitted values back into the shared fields. Takes priority so the
    // admin's typed values survive a series-action round-trip.
    if (applyToSeries && !seriesState.ok && seriesState.values) {
      return {
        programId: seriesState.values.programId,
        startTime: seriesState.values.startTime,
        endTime: seriesState.values.endTime,
        note: seriesState.values.note,
      };
    }
    if (!state.ok && state.values) {
      return {
        programId: state.values.programId,
        startTime: state.values.startTime,
        endTime: state.values.endTime,
        note: state.values.note,
      };
    }
    if (isEdit && editInitial) {
      return {
        programId: editInitial.programId,
        startTime: formatPfaTime(editInitial.startAt),
        endTime: formatPfaTime(editInitial.endAt),
        note: editInitial.note ?? "",
      };
    }
    if (!isEdit && createPrefill) {
      return {
        programId: createPrefill.programId,
        startTime: createPrefill.startTime,
        endTime: createPrefill.endTime,
        note: "",
      };
    }
    return {
      programId: "",
      startTime: "09:00",
      endTime: "10:00",
      note: "",
    };
  }, [isEdit, editInitial, createPrefill, state, applyToSeries, seriesState]);

  const programName = useMemo(() => {
    if (!editInitial) return "";
    return (
      programs.find((p) => p.id === editInitial.programId)?.name ??
      editInitial.programId
    );
  }, [editInitial, programs]);

  // QA10 W3.2: the summary "Coach" row lists every scheduled coach (primary
  // first), resolved to display names via the coaches list.
  const coachName = useMemo(() => {
    if (!editInitial) return "";
    const ids =
      editInitial.scheduledCoachIds?.length > 0
        ? editInitial.scheduledCoachIds
        : [editInitial.scheduledCoachId];
    return ids
      .map((id) => {
        const coach = coaches.find((c) => c.id === id);
        return coach ? (coach.name ?? coach.email) : id;
      })
      .join(", ");
  }, [editInitial, coaches]);

  // QA10 W3.3: the summary "Occupies" row — the names of the cage resources
  // this block occupies (its linked blocked_times), or "—" when none.
  const occupiesLabel = useMemo(() => {
    const ids = editInitial?.resourceIds ?? [];
    if (ids.length === 0) return "—";
    const names = ids
      .map((id) => resources.find((r) => r.id === id)?.name ?? id)
      .sort();
    return names.join(", ");
  }, [editInitial, resources]);

  // Recurrence summary line for a series occurrence, e.g.
  // "Repeats Mon, Wed · through Aug 30, 2026".
  const recurrenceLine = useMemo(() => {
    if (!editSeriesInitial) return "";
    const days = formatWeekdayList(editSeriesInitial.daysOfWeek);
    return `Repeats ${days} · through ${formatIsoDateMedium(editSeriesInitial.endsOn)}`;
  }, [editSeriesInitial]);

  // QA10 W3.1b: derive the (frequency, interval) submitted by each form
  // from its chosen pattern. Monthly hides the weekday pills and submits a
  // single derived weekday so the schema's non-empty constraint holds; the
  // occurrence weekday + ordinal come from the start date (grid date for
  // create; seriesStartsOn for edit).
  const createFreq = freqIntervalForKind(freqKind, everyNWeeks);
  const createIsMonthly = createFreq.frequency === "monthly";
  const createMonthlyHint = monthlyHint(dateInput);

  const seriesFreq = freqIntervalForKind(seriesFreqKind, seriesEveryNWeeks);
  const seriesIsMonthly = seriesFreq.frequency === "monthly";
  const seriesMonthlyHint = monthlyHint(seriesStartsOn);
  // The monthly weekday submitted for the edit-series form, derived from
  // the season-start date (null until a valid date is chosen).
  const weekdayFromIsoForSeries = weekdayFromIso(seriesStartsOn);

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
                Work block
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
            <ReconBanner reconciliation={reconciliation} />
          ) : null}

          <dl className="space-y-3">
            <DetailRow label="Work" value={programName} />
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
            <DetailRow label="Occupies" value={occupiesLabel} />
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
        action={applyToSeries ? seriesFormAction : formAction}
        key={applyToSeries ? `${seriesFormKey}-applyall` : formKey}
        onSubmit={(e) => {
          // Client guard for the recurring path: at least one weekday must
          // be checked. The server schema is still the source of truth, but
          // this gives an immediate inline message. endsOn `required` on the
          // DateInput blocks an empty season-end via native validation.
          if (
            !isEdit &&
            recurring &&
            !createIsMonthly &&
            selectedDays.size === 0
          ) {
            e.preventDefault();
            setRecurError("Pick at least one weekday.");
          }
          // #10: same weekday guard for an apply-to-all (series) edit of a
          // recurring occurrence. Monthly derives its weekday from the start
          // date so the guard is skipped there.
          if (
            applyToSeries &&
            !seriesIsMonthly &&
            seriesDays.size === 0
          ) {
            e.preventDefault();
            setSeriesError("Pick at least one weekday.");
          }
        }}
        className="space-y-5 p-6"
      >
        {/* Single-occurrence edit submits the block id; an apply-to-all
            (#10) edit submits the parent series id instead. */}
        {isEdit && editInitial && !applyToSeries ? (
          <input type="hidden" name="id" defaultValue={editInitial.id} />
        ) : null}
        {isEdit && applyToSeries && editInitial?.seriesId ? (
          <input
            type="hidden"
            name="seriesId"
            defaultValue={editInitial.seriesId}
          />
        ) : null}

        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.14em] text-fg-muted">
              {isEdit ? "Edit" : "Schedule"}
            </p>
            <h2 className="text-xl font-semibold tracking-tight mt-0.5">
              Work block
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

        {/* #10: surface whichever action backs the current submit — the
            series action when "apply to all" is ticked, else the single
            block action. */}
        {applyToSeries ? (
          !seriesState.ok ? (
            <div
              role="alert"
              className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
            >
              {seriesState.error.message}
            </div>
          ) : null
        ) : !state.ok ? (
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
          <ReconBanner reconciliation={reconciliation} />
        ) : null}

        <div className="space-y-3">
          <Field label="Work">
            <select
              name="programId"
              required
              defaultValue={defaults.programId}
              className={selectStyles}
            >
              <option value="" disabled>
                Choose work…
              </option>
              {programs.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>

          <CoachMultiSelect
            coachIds={blockCoachIds}
            coaches={coaches}
            onChangeAt={(i, v) => setCoachAt(setBlockCoachIds, i, v)}
            onAdd={() => addCoachRow(setBlockCoachIds)}
            onRemoveAt={(i) => removeCoachRow(setBlockCoachIds, i)}
          />

          <OccupiesResources
            resources={resources}
            selected={blockResourceIds}
            onToggle={(id) => toggleResource(setBlockResourceIds, id)}
          />

          {!applyToSeries ? (
            isSeries ? (
              // A recurring-series occurrence keeps its date fixed: moving one
              // occurrence to another day would desync it from the series (no
              // skipDates bookkeeping), so a later "Apply to all" edit would
              // delete/orphan it. Submit the date as a hidden field so the update
              // still composes startAt/endAt; to move it, use "Apply to all" or
              // cancel + recreate.
              <input type="hidden" name="date" defaultValue={formDate} />
            ) : (
              <Field label="Date">
                <DateInput
                  name="date"
                  value={formDate}
                  onChange={(iso) => {
                    setFormDate(iso);
                    if (!isEdit) {
                      // Guard: weekdayFromIso returns null for an empty/partial
                      // date, so a mid-typed value can't reach parsePfaInput and
                      // throw (which would white-screen the dialog).
                      const wd = weekdayFromIso(iso);
                      if (wd !== null) setSelectedDays(new Set([wd]));
                      setRecurError(null);
                    }
                  }}
                  required
                  aria-label="Date"
                />
              </Field>
            )
          ) : null}

          <div className="grid grid-cols-2 gap-3">
            <Field label="Start">
              <TimeSelect
                name="startTime"
                variant="start"
                required
                stepMinutes={15}
                defaultValue={defaults.startTime}
                className={selectStyles}
              />
            </Field>
            <Field label="End">
              <TimeSelect
                name="endTime"
                variant="end"
                required
                stepMinutes={15}
                defaultValue={defaults.endTime}
                className={selectStyles}
              />
            </Field>
          </div>

          {/* #10: when "apply to all" is ticked for a recurring occurrence,
              reveal the series-level fields (frequency/interval, weekday
              pills, season start/end) so a series-wide edit has everything
              the series action needs. These submit only while applyToSeries
              is true (this branch unmounts when unchecked). */}
          {isEdit && isSeries && applyToSeries ? (
            <div className="space-y-3 rounded-md border border-gold/30 bg-gold/[0.04] p-3">
              <p className="text-[11px] uppercase tracking-wider text-gold-strong font-medium">
                Recurring series settings
              </p>

              {/* QA10 W3.1b: pattern → (frequency, interval) for the whole
                  series, submitted as hidden fields. */}
              <input
                type="hidden"
                name="frequency"
                value={seriesFreq.frequency}
              />
              <input type="hidden" name="interval" value={seriesFreq.interval} />

              <Field label="Frequency">
                <select
                  aria-label="Frequency"
                  value={seriesFreqKind}
                  onChange={(e) => {
                    setSeriesFreqKind(e.target.value as FrequencyKind);
                    setSeriesError(null);
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

              {seriesFreqKind === "everyN" ? (
                <Field
                  label="Every N weeks"
                  hint="Repeats every N weeks on the chosen days."
                >
                  <input
                    type="number"
                    min={1}
                    step={1}
                    aria-label="Number of weeks between occurrences"
                    value={seriesEveryNWeeks}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      setSeriesEveryNWeeks(Number.isFinite(n) && n >= 1 ? n : 1);
                      setSeriesError(null);
                    }}
                    className={inputStyles}
                  />
                </Field>
              ) : null}

              {seriesIsMonthly ? (
                <div>
                  {/* Monthly derives weekday + ordinal from the season-start
                      date; pills don't apply. Submit one derived weekday so
                      the schema's non-empty daysOfWeek constraint holds. */}
                  {weekdayFromIsoForSeries !== null ? (
                    <input
                      type="hidden"
                      name="daysOfWeek"
                      value={weekdayFromIsoForSeries}
                    />
                  ) : null}
                  <span className="text-xs uppercase tracking-wider text-fg-muted block mb-1.5">
                    Repeats
                  </span>
                  <p className="text-sm text-fg">
                    {seriesMonthlyHint ||
                      "Pick a season-start date to set the monthly weekday."}
                  </p>
                </div>
              ) : (
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
              )}

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
                  {/* The series form submits via a native form action, so the
                      endsOn ISO rides a hidden input; the presets control just
                      drives the state that feeds it. */}
                  <input type="hidden" name="endsOn" value={seriesEndsOn} />
                  <RepeatsUntilPresets
                    startsOn={seriesStartsOn}
                    endsOn={seriesEndsOn}
                    onEndsOnChange={(iso) => {
                      setSeriesEndsOn(iso);
                      setSeriesError(null);
                    }}
                  />
                </Field>
              </div>

              {seriesError ? (
                <p role="alert" className="text-[11px] text-danger leading-snug">
                  {seriesError}
                </p>
              ) : null}

              <p className="text-[11px] text-fg-subtle leading-snug">
                Saving updates the whole series and regenerates future dates.
              </p>
            </div>
          ) : null}

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
                <span className="text-sm text-fg">Repeats</span>
              </label>

              {recurring ? (
                <div className="space-y-3 rounded-md border border-line bg-surface-2/40 p-3">
                  {/* QA10 W3.1b: the chosen pattern → (frequency, interval)
                      the series action understands, submitted as hidden
                      fields so form-actions/zod read them. */}
                  <input
                    type="hidden"
                    name="frequency"
                    value={createFreq.frequency}
                  />
                  <input
                    type="hidden"
                    name="interval"
                    value={createFreq.interval}
                  />

                  <Field label="Frequency">
                    <select
                      aria-label="Frequency"
                      value={freqKind}
                      onChange={(e) => {
                        setFreqKind(e.target.value as FrequencyKind);
                        setRecurError(null);
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
                    <Field
                      label="Every N weeks"
                      hint="Repeats every N weeks on the chosen days."
                    >
                      <input
                        type="number"
                        min={1}
                        step={1}
                        aria-label="Number of weeks between occurrences"
                        value={everyNWeeks}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          setEveryNWeeks(Number.isFinite(n) && n >= 1 ? n : 1);
                          setRecurError(null);
                        }}
                        className={inputStyles}
                      />
                    </Field>
                  ) : null}

                  {createIsMonthly ? (
                    <div>
                      {/* Monthly derives its weekday + ordinal from the
                          grid's selected date; pills don't apply. Submit a
                          single derived weekday so the schema's non-empty
                          daysOfWeek constraint still holds. */}
                      <input
                        type="hidden"
                        name="daysOfWeek"
                        value={selectedWeekday}
                      />
                      <span className="text-xs uppercase tracking-wider text-fg-muted block mb-1.5">
                        Repeats
                      </span>
                      <p className="text-sm text-fg">
                        {createMonthlyHint || "On the same weekday each month"}
                      </p>
                    </div>
                  ) : (
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
                  )}

                  <Field
                    label="Season ends on"
                    hint="Repeats through this date."
                  >
                    {/* Native form action submits endsOn via FormData, so the
                        ISO rides a hidden input; the presets control drives the
                        state that feeds it. */}
                    <input type="hidden" name="endsOn" value={endsOn} />
                    <RepeatsUntilPresets
                      startsOn={formDate}
                      endsOn={endsOn}
                      onEndsOnChange={(iso) => {
                        setEndsOn(iso);
                        setRecurError(null);
                      }}
                    />
                  </Field>

                  {/* Guard the parse: only resolve formDate to a label when
                      it's a valid ISO date (weekdayFromIso != null), else the
                      empty/partial case would throw in parsePfaInput and crash
                      the dialog. */}
                  {weekdayFromIso(formDate) !== null ? (
                    <p className="text-[11px] text-fg-subtle leading-snug">
                      Creates a block from{" "}
                      {formatPfaDateMedium(parsePfaInput(formDate, "12:00"))}{" "}
                      through the end date.
                    </p>
                  ) : (
                    <p className="text-[11px] text-fg-subtle leading-snug">
                      Creates a repeating block through the end date.
                    </p>
                  )}

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

        {/* #10: recurring-occurrence edits default to THIS occurrence only.
            Ticking this opts into a series-wide edit — switches the form's
            action to the series action + reveals the series settings above. */}
        {isEdit && isSeries ? (
          <div className="rounded-md border border-line bg-surface-2/40 px-3 py-2.5">
            <label className="flex items-center gap-2.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={applyToSeries}
                onChange={(e) => {
                  setApplyToSeries(e.target.checked);
                  setSeriesError(null);
                }}
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
        ) : null}

        <div className="flex items-center justify-between gap-2 pt-2">
          {isEdit ? (
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting || pending || seriesPending}
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
              disabled={pending || seriesPending || deleting}
              className="rounded-md bg-gold text-gold-ink shadow-[var(--shadow-sm)] hover:bg-gold-hover h-9 px-4 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
            >
              {applyToSeries
                ? seriesPending
                  ? "Saving…"
                  : "Save series"
                : pending
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

// QA10 W3.2: a multi-coach picker — a primary <select> plus "+ Add another
// coach" rows. Every <select> uses name="scheduledCoachIds" so the action
// receives the full set via getAll. The first row is the primary; extra
// rows can be removed. De-dupe is left to the action.
function CoachMultiSelect({
  coachIds,
  coaches,
  onChangeAt,
  onAdd,
  onRemoveAt,
}: {
  coachIds: string[];
  coaches: CoachOption[];
  onChangeAt: (index: number, value: string) => void;
  onAdd: () => void;
  onRemoveAt: (index: number) => void;
}) {
  return (
    <div className="space-y-2">
      <span className="text-xs uppercase tracking-wider text-fg-muted block mb-1.5">
        Scheduled coach{coachIds.length > 1 ? "es" : ""}
      </span>
      {coachIds.map((id, index) => (
        <div key={index} className="flex items-center gap-2">
          <select
            name="scheduledCoachIds"
            required
            aria-label={index === 0 ? "Scheduled coach" : `Coach ${index + 1}`}
            value={id}
            onChange={(e) => onChangeAt(index, e.target.value)}
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
          {index > 0 ? (
            <button
              type="button"
              onClick={() => onRemoveAt(index)}
              aria-label="Remove coach"
              className="inline-flex items-center justify-center h-9 w-9 shrink-0 rounded-md border border-line text-fg-muted hover:text-danger hover:border-danger/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      ))}
      <button
        type="button"
        onClick={onAdd}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-gold-strong hover:text-gold-hover focus-visible:outline-none focus-visible:underline transition-colors"
      >
        <Plus className="h-3.5 w-3.5" />
        Add another coach
      </button>
    </div>
  );
}

// QA10 W3.3: a checkbox group of cage resources a program block occupies.
// Each checkbox submits name="resourceIds" value=resource.id so the action
// receives the full set via getAll. Controlled by the parent's selection
// state. Leaving all unchecked = no occupancy (today's behavior). Resources
// are grouped by type for readability.
const RESOURCE_TYPE_LABELS: Record<ResourceOption["type"], string> = {
  cage: "Cages",
  bullpen: "Bullpens",
  weight_room: "Weight room",
};
const RESOURCE_TYPE_ORDER: ResourceOption["type"][] = [
  "cage",
  "bullpen",
  "weight_room",
];

function OccupiesResources({
  resources,
  selected,
  onToggle,
}: {
  resources: ResourceOption[];
  selected: string[];
  onToggle: (resourceId: string) => void;
}) {
  if (resources.length === 0) return null;
  const selectedSet = new Set(selected);
  const groups = RESOURCE_TYPE_ORDER.map((type) => ({
    type,
    items: resources.filter((r) => r.type === type),
  })).filter((g) => g.items.length > 0);

  return (
    <div>
      <span className="text-xs uppercase tracking-wider text-fg-muted block mb-1.5">
        Occupies cage resources
      </span>
      <div className="space-y-2.5 rounded-md border border-line bg-surface-2/40 p-3">
        {groups.map((g) => (
          <div key={g.type}>
            <span className="text-[10px] uppercase tracking-wider text-fg-subtle block mb-1">
              {RESOURCE_TYPE_LABELS[g.type]}
            </span>
            <div className="flex flex-wrap gap-1.5">
              {g.items.map((r) => {
                const active = selectedSet.has(r.id);
                return (
                  <label
                    key={r.id}
                    className={`inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border text-xs font-medium cursor-pointer select-none transition-colors focus-within:outline-none focus-within:ring-2 focus-within:ring-gold/40 ${
                      active
                        ? "bg-gold/10 border-gold/40 text-gold-strong"
                        : "border-line text-fg-muted hover:text-fg hover:border-line-strong"
                    }`}
                  >
                    <input
                      type="checkbox"
                      name="resourceIds"
                      value={r.id}
                      checked={active}
                      onChange={() => onToggle(r.id)}
                      className="sr-only"
                    />
                    {r.name}
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <span className="block text-[11px] text-fg-subtle mt-1 leading-snug">
        Optional — ticked resources are blocked for coach booking during this
        block&apos;s time.
      </span>
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
