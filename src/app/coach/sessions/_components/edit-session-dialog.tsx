"use client";

import { useActionState, useEffect, useMemo, useRef } from "react";
import { X } from "lucide-react";
import {
  updateOwnSessionFormAction,
  type EditActionResult,
} from "../form-actions";
import type { ResourceOption } from "./types";
import { TimeSelect } from "@/app/_components/time-select";
import { DateInput } from "@/app/_components/date-input";
import { GroupPill } from "@/app/_components/group-pill";
import { formatPfaDate, formatPfaTime } from "@/lib/timezone";

// Edit dialog for a coach's existing session. Mirrors the admin
// session-form-dialog (native <dialog>, useActionState, error
// remount pattern) but without the coach picker — the server
// action force-overrides coachId regardless of what we send anyway.

export type SessionInitial = {
  id: string;
  resourceId: string;
  startAt: Date;
  endAt: Date;
  note: string | null;
  // Display-only: true for a weight-room rental billed at the group rate.
  isGroupSession: boolean;
};

const INITIAL_STATE: EditActionResult = { ok: true };

export function EditSessionDialog({
  open,
  onClose,
  resources,
  initial,
  isPast = false,
}: {
  open: boolean;
  onClose: () => void;
  resources: ResourceOption[];
  initial: SessionInitial | null;
  // 1b security: when the rental has already started the coach can only
  // edit the note — the billable fields (resource/date/start/end) are
  // disabled here to match the server-side immutability.
  isPast?: boolean;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [state, formAction, pending] = useActionState(
    updateOwnSessionFormAction,
    INITIAL_STATE,
  );

  // Sync the React open prop with the native <dialog> element.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Auto-close on a successful save (state.ok && we just submitted).
  // Tracked via a ref so we only close once per submit cycle.
  const wasPending = useRef(false);
  useEffect(() => {
    if (wasPending.current && !pending && state.ok && open) {
      onClose();
    }
    wasPending.current = pending;
  }, [pending, state, open, onClose]);

  // Pick up Escape / backdrop click via the native close event.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handler = () => {
      if (open) onClose();
    };
    dialog.addEventListener("close", handler);
    return () => dialog.removeEventListener("close", handler);
  }, [open, onClose]);

  const cages = resources.filter((r) => r.type === "cage");
  const bullpens = resources.filter((r) => r.type === "bullpen");
  const weightRooms = resources.filter((r) => r.type === "weight_room");

  const defaults = useMemo(() => {
    if (!state.ok && state.values) {
      return state.values;
    }
    if (initial) {
      return {
        resourceId: initial.resourceId,
        date: toDateInput(initial.startAt),
        startTime: toTimeInput(initial.startAt),
        endTime: toTimeInput(initial.endAt),
        note: initial.note ?? "",
      };
    }
    return {
      resourceId: "",
      date: "",
      startTime: "",
      endTime: "",
      note: "",
    };
  }, [initial, state]);

  return (
    <dialog
      ref={dialogRef}
      className="m-auto w-full max-w-lg rounded-2xl border border-line bg-surface text-fg shadow-[var(--shadow-lg)] p-0 backdrop:bg-page/70 backdrop:backdrop-blur-sm"
    >
      <form
        action={formAction}
        key={
          state.ok
            ? `edit-${initial?.id ?? "none"}-${isPast ? "past" : "future"}`
            : `edit-err-${state.error.code}-${state.error.message}`
        }
        className="space-y-5 p-6"
      >
        {initial ? (
          <input type="hidden" name="id" defaultValue={initial.id} />
        ) : null}

        {/* PAST rental: the billable inputs are disabled (so they're not in
            FormData) — these hidden fields carry the ORIGINAL values so the
            server's note-only update sees no billable change and accepts it. */}
        {isPast && initial ? (
          <>
            <input
              type="hidden"
              name="resourceId"
              defaultValue={initial.resourceId}
            />
            <input
              type="hidden"
              name="date"
              defaultValue={toDateInput(initial.startAt)}
            />
            <input
              type="hidden"
              name="startTime"
              defaultValue={toTimeInput(initial.startAt)}
            />
            <input
              type="hidden"
              name="endTime"
              defaultValue={toTimeInput(initial.endAt)}
            />
          </>
        ) : null}

        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.14em] text-fg-muted">
              Edit
            </p>
            <div className="flex items-center gap-2 mt-0.5">
              <h2 className="text-xl font-semibold tracking-tight">
                Rental details
              </h2>
              {initial?.isGroupSession ? <GroupPill /> : null}
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

        {!state.ok ? (
          <div
            role="alert"
            className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
          >
            {state.error.message}
          </div>
        ) : null}

        {isPast ? (
          <div className="rounded-md border border-line-strong bg-surface-2 px-3 py-2 text-xs text-fg-muted leading-relaxed">
            Already started — you can only edit the note, or request removal.
          </div>
        ) : null}

        <div className="space-y-3">
          <Field label="Resource">
            <select
              name={isPast ? undefined : "resourceId"}
              required={!isPast}
              disabled={isPast}
              defaultValue={defaults.resourceId}
              className={`${selectStyles} disabled:opacity-60 disabled:cursor-not-allowed`}
            >
              <option value="" disabled>
                Choose a resource…
              </option>
              {cages.length > 0 ? (
                <optgroup label="Cages">
                  {cages.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {bullpens.length > 0 ? (
                <optgroup label="Bullpens">
                  {bullpens.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {weightRooms.length > 0 ? (
                <optgroup label="Weight Room">
                  {weightRooms.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </select>
          </Field>

          <div className="grid grid-cols-3 gap-3">
            {/* PAST rental: render disabled read-only displays (no `name`, so
                they don't submit) — the hidden fields above carry the values.
                FUTURE rental: the editable date/time controls. */}
            {isPast ? (
              <>
                <Field label="Date">
                  <input
                    type="text"
                    value={defaults.date}
                    disabled
                    readOnly
                    className={`${inputStyles} disabled:opacity-60 disabled:cursor-not-allowed`}
                  />
                </Field>
                <Field label="Start">
                  <input
                    type="text"
                    value={defaults.startTime}
                    disabled
                    readOnly
                    className={`${inputStyles} disabled:opacity-60 disabled:cursor-not-allowed`}
                  />
                </Field>
                <Field label="End">
                  <input
                    type="text"
                    value={defaults.endTime}
                    disabled
                    readOnly
                    className={`${inputStyles} disabled:opacity-60 disabled:cursor-not-allowed`}
                  />
                </Field>
              </>
            ) : (
              <>
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
              </>
            )}
          </div>

          <Field label="Note" optional>
            <input
              type="text"
              name="note"
              defaultValue={defaults.note}
              maxLength={500}
              placeholder="Optional context"
              className={inputStyles}
            />
          </Field>
        </div>

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-line-strong bg-surface text-fg-muted shadow-[var(--shadow-sm)] hover:text-fg hover:-translate-y-px hover:shadow-[var(--shadow-md)] h-9 px-4 text-sm font-medium transition"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={pending}
            className="rounded-lg bg-gold text-gold-ink hover:bg-gold-hover shadow-[var(--shadow-sm)] h-9 px-4 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
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
  "w-full rounded-lg bg-surface border border-line text-fg placeholder:text-fg-subtle px-3 py-2 text-sm focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40";
const selectStyles = `${inputStyles} appearance-none pr-8`;

// Inputs render PFA wall-clock — same value regardless of viewer's browser TZ.
const toDateInput = formatPfaDate;
const toTimeInput = formatPfaTime;
