"use client";

import {
  useActionState,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type FormEvent,
} from "react";
import { X } from "lucide-react";
import {
  createSessionFormAction,
  updateSessionFormAction,
  type ActionResult,
} from "../form-actions";
import { createSessionsBatch } from "../actions";
import type { CoachOption, ResourceOption } from "./sessions-client";
import { TimeSelect } from "@/app/_components/time-select";
import { TeamRentalCheckbox } from "@/app/_components/team-rental-checkbox";
import { SlotLengthToggle } from "@/app/_components/slot-length-toggle";
import {
  SessionSlotsList,
  type SlotInput,
} from "@/app/_components/session-slots-list";
import {
  formatPfaDate,
  formatPfaTime,
  parsePfaInput,
} from "@/lib/timezone";

export type SessionFormInitialValues = {
  id: string;
  coachId: string;
  resourceId: string;
  startAt: Date;
  endAt: Date;
  useType: "hitting" | "pitching" | null;
  note: string | null;
  isTeamRental: boolean;
};

// Modal form for creating or editing a session.
//
// In edit mode: same flow as before — form-action submits the
// underlying update. Multi-slot is NOT supported (you're editing
// one row).
//
// In create mode: when the time range covers > 1 slot of the chosen
// length, the single Note + TeamRental fields swap for a list of N
// notecards, and submit dispatches to createSessionsBatch (bypassing
// the form-action layer). Sub-1-slot creates use the original
// createSessionFormAction path.

const INITIAL_STATE: ActionResult = { ok: true };

export function SessionFormDialog({
  open,
  mode,
  onClose,
  coachOptions,
  resourceOptions,
  initial,
}: {
  open: boolean;
  mode: "create" | "edit";
  onClose: () => void;
  coachOptions: CoachOption[];
  resourceOptions: ResourceOption[];
  initial?: SessionFormInitialValues;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const action =
    mode === "edit" ? updateSessionFormAction : createSessionFormAction;
  const [state, formAction, pending] = useActionState(action, INITIAL_STATE);

  // Batch-create path state (create mode + N>1 only).
  const [batchPending, startBatchTransition] = useTransition();
  const [batchError, setBatchError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Auto-close after a successful submit (single-slot path). For
  // batch path, we close in the transition's success branch directly.
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
        coachId: initial.coachId,
        resourceId: initial.resourceId,
        date: toDateInput(initial.startAt),
        startTime: toTimeInput(initial.startAt),
        endTime: toTimeInput(initial.endAt),
        useType: initial.useType ?? "",
        note: initial.note ?? "",
        isTeamRental: initial.isTeamRental,
      };
    }
    const now = new Date();
    return {
      coachId: "",
      resourceId: "",
      date: toDateInput(now),
      startTime: "09:00",
      endTime: "10:00",
      useType: "",
      note: "",
      isTeamRental: false,
    };
  }, [initial, state]);

  // Controlled state for the fields multi-slot math depends on.
  // Other fields stay uncontrolled (defaultValue). We re-seed on
  // defaults change.
  const [live, setLive] = useState({
    coachId: defaults.coachId,
    resourceId: defaults.resourceId,
    date: defaults.date,
    startTime: defaults.startTime,
    endTime: defaults.endTime,
    useType: defaults.useType,
  });
  const [prevDefaults, setPrevDefaults] = useState(defaults);
  if (defaults !== prevDefaults) {
    setPrevDefaults(defaults);
    setLive({
      coachId: defaults.coachId,
      resourceId: defaults.resourceId,
      date: defaults.date,
      startTime: defaults.startTime,
      endTime: defaults.endTime,
      useType: defaults.useType,
    });
    setBatchError(null);
  }

  // Multi-slot state (create mode only).
  const [slotLengthMinutes, setSlotLengthMinutes] = useState<30 | 60>(30);
  const [slots, setSlots] = useState<SlotInput[]>([]);

  const { rangeStart, rangeEnd, slotCount, divisibilityError } = useMemo(() => {
    if (!live.date || !live.startTime || !live.endTime) {
      return {
        rangeStart: null,
        rangeEnd: null,
        slotCount: 0,
        divisibilityError: false,
      };
    }
    let start: Date;
    let end: Date;
    try {
      start = parsePfaInput(live.date, live.startTime);
      end = parsePfaInput(live.date, live.endTime);
    } catch {
      return {
        rangeStart: null,
        rangeEnd: null,
        slotCount: 0,
        divisibilityError: false,
      };
    }
    const totalMs = end.getTime() - start.getTime();
    const lengthMs = slotLengthMinutes * 60_000;
    if (totalMs <= 0) {
      return {
        rangeStart: start,
        rangeEnd: end,
        slotCount: 0,
        divisibilityError: false,
      };
    }
    if (totalMs % lengthMs !== 0) {
      return {
        rangeStart: start,
        rangeEnd: end,
        slotCount: 0,
        divisibilityError: true,
      };
    }
    return {
      rangeStart: start,
      rangeEnd: end,
      slotCount: totalMs / lengthMs,
      divisibilityError: false,
    };
  }, [live.date, live.startTime, live.endTime, slotLengthMinutes]);

  const isCreate = mode === "create";
  const isMultiSlot = isCreate && slotCount > 1;

  const submitLabel = (() => {
    if (pending || batchPending) return "Saving…";
    if (mode === "edit") return "Save changes";
    if (slotCount > 1) return `Create ${slotCount} sessions`;
    return "Create session";
  })();

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    if (!isMultiSlot) return; // let form-action handle it
    e.preventDefault();
    if (slotCount === 0 || divisibilityError || slots.length === 0) return;

    setBatchError(null);
    startBatchTransition(async () => {
      try {
        await createSessionsBatch({
          coachId: live.coachId,
          resourceId: live.resourceId,
          useType:
            live.useType === "hitting" || live.useType === "pitching"
              ? live.useType
              : null,
          slots: slots.map((s) => ({
            startAt: s.startAt,
            endAt: s.endAt,
            note: s.note.trim() || null,
            isTeamRental: s.isTeamRental,
          })),
        });
        setSlots([]);
        onClose();
      } catch (err) {
        setBatchError(
          err instanceof Error ? err.message : "Batch create failed",
        );
      }
    });
  };

  return (
    <dialog
      ref={dialogRef}
      className="m-auto w-full max-w-lg rounded-lg border border-line bg-surface text-fg p-0 backdrop:bg-page/70 backdrop:backdrop-blur-sm"
    >
      <form
        action={formAction}
        onSubmit={handleSubmit}
        key={
          state.ok
            ? `${mode}-${initial?.id ?? "new"}`
            : `${mode}-err-${state.error.code}-${state.error.message}`
        }
        className="space-y-5 p-6"
      >
        {mode === "edit" && initial ? (
          <input type="hidden" name="id" defaultValue={initial.id} />
        ) : null}

        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.14em] text-fg-muted">
              {mode === "edit" ? "Edit" : "New"}
            </p>
            <h2 className="text-xl font-semibold tracking-tight mt-0.5">
              Session details
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

        {batchError ? (
          <div
            role="alert"
            className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
          >
            {batchError}
          </div>
        ) : null}

        <div className="space-y-3">
          <Field label="Coach">
            <select
              name="coachId"
              required
              value={live.coachId}
              onChange={(e) =>
                setLive((p) => ({ ...p, coachId: e.target.value }))
              }
              className={selectStyles}
            >
              <option value="" disabled>
                Choose a coach…
              </option>
              {coachOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name ?? c.email}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Resource">
            <select
              name="resourceId"
              required
              value={live.resourceId}
              onChange={(e) =>
                setLive((p) => ({ ...p, resourceId: e.target.value }))
              }
              className={selectStyles}
            >
              <option value="" disabled>
                Choose a resource…
              </option>
              {resourceOptions.map((r) => (
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
                value={live.date}
                onChange={(e) =>
                  setLive((p) => ({ ...p, date: e.target.value }))
                }
                className={inputStyles}
              />
            </Field>
            <Field label="Start">
              <TimeSelect
                name="startTime"
                variant="start"
                required
                value={live.startTime}
                onChange={(v) => setLive((p) => ({ ...p, startTime: v }))}
                className={selectStyles}
              />
            </Field>
            <Field label="End">
              <TimeSelect
                name="endTime"
                variant="end"
                required
                value={live.endTime}
                onChange={(v) => setLive((p) => ({ ...p, endTime: v }))}
                className={selectStyles}
              />
            </Field>
          </div>

          {isCreate ? (
            <Field
              label="Slot length"
              hint="30 min = back-to-back half-hour lessons. 1 hr = full hours."
            >
              <SlotLengthToggle
                value={slotLengthMinutes}
                onChange={(v) => setSlotLengthMinutes(v)}
              />
            </Field>
          ) : null}

          {isCreate && divisibilityError ? (
            <div
              role="alert"
              className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
            >
              Range isn&apos;t a clean multiple of {slotLengthMinutes} min — pick
              different start/end times.
            </div>
          ) : null}

          {isCreate && slotCount > 0 && !divisibilityError ? (
            <p className="text-xs text-fg-subtle">
              Will create <span className="text-fg">{slotCount}</span>{" "}
              {slotCount === 1 ? "session" : "sessions"} of{" "}
              {slotLengthMinutes} min each.
            </p>
          ) : null}

          <Field
            label="Use type"
            hint="Required for cages (hitting or pitching). Leave blank for bullpens and weight rooms."
          >
            <select
              name="useType"
              value={live.useType}
              onChange={(e) =>
                setLive((p) => ({ ...p, useType: e.target.value }))
              }
              className={selectStyles}
            >
              <option value="">— None (bullpen / weight room)</option>
              <option value="hitting">Hitting</option>
              <option value="pitching">Pitching</option>
            </select>
          </Field>

          {!isMultiSlot ? (
            <>
              <Field label="Note" optional>
                <input
                  type="text"
                  name="note"
                  defaultValue={defaults.note}
                  maxLength={500}
                  placeholder="Optional context (e.g. JP De La Cruz, online)"
                  className={inputStyles}
                />
              </Field>

              <TeamRentalCheckbox defaultChecked={defaults.isTeamRental} />
            </>
          ) : (
            <SessionSlotsList
              rangeStart={rangeStart}
              rangeEnd={rangeEnd}
              slotLengthMinutes={slotLengthMinutes}
              slots={slots}
              onChange={setSlots}
            />
          )}
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
            disabled={
              pending ||
              batchPending ||
              (isMultiSlot && (slotCount === 0 || divisibilityError))
            }
            className="rounded-md bg-gold text-gold-ink hover:bg-gold-hover h-9 px-4 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
          >
            {submitLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function Field({
  label,
  hint,
  optional,
  children,
}: {
  label: string;
  hint?: string;
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
