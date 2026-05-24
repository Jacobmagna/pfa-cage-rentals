"use client";

import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import {
  createSessionFormAction,
  type ActionResult as SessionActionResult,
} from "@/app/admin/sessions/form-actions";
import type {
  CoachOption,
  ResourceOption,
} from "@/app/admin/sessions/_components/sessions-client";
import {
  createBlockFormAction,
  type BlockActionResult,
} from "../form-actions";

// Unified "create on the grid" dialog. Two tabs:
//   - Session: full session form (coach dropdown + use type + note)
//   - Block:   simpler form (free-text reason — for summer camps,
//              team rentals, HVAC repairs, etc.)
// Both pre-fill resource + date + start/end from the cell click,
// so the admin types the minimum needed.
//
// Each tab has its own <form action={...}> + useActionState, keyed
// by a separate state, so switching tabs doesn't carry submit state
// across.

export type CreatePrefill = {
  resourceId: string;
  /** Pre-selected date/time in the dialog (Date object, local TZ). */
  startAt: Date;
  endAt: Date;
};

const SESSION_INITIAL: SessionActionResult = { ok: true };
const BLOCK_INITIAL: BlockActionResult = { ok: true };

export function ScheduleCreateDialog({
  open,
  onClose,
  coaches,
  resources,
  prefill,
}: {
  open: boolean;
  onClose: () => void;
  coaches: CoachOption[];
  resources: ResourceOption[];
  prefill: CreatePrefill | null;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<"session" | "block">("session");

  const [sessionState, sessionAction, sessionPending] = useActionState(
    createSessionFormAction,
    SESSION_INITIAL,
  );
  const [blockState, blockAction, blockPending] = useActionState(
    createBlockFormAction,
    BLOCK_INITIAL,
  );

  // Sync native <dialog> open state with React.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Tab state persists across opens by design — if an admin just
  // created a Block, the next click is plausibly another Block. No
  // reset effect here (eslint react-hooks/set-state-in-effect rule
  // catches that pattern anyway).

  // Auto-close on successful submit (whichever tab fired).
  const wasSessionPending = useRef(false);
  const wasBlockPending = useRef(false);
  useEffect(() => {
    if (
      wasSessionPending.current &&
      !sessionPending &&
      sessionState.ok &&
      open
    ) {
      onClose();
    }
    wasSessionPending.current = sessionPending;
  }, [sessionPending, sessionState, open, onClose]);
  useEffect(() => {
    if (wasBlockPending.current && !blockPending && blockState.ok && open) {
      onClose();
    }
    wasBlockPending.current = blockPending;
  }, [blockPending, blockState, open, onClose]);

  // Native close event (Escape, backdrop click).
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handler = () => {
      if (open) onClose();
    };
    dialog.addEventListener("close", handler);
    return () => dialog.removeEventListener("close", handler);
  }, [open, onClose]);

  // Defaults for the form fields.
  const sessionDefaults = useMemo(() => {
    if (!sessionState.ok && sessionState.values) return sessionState.values;
    return {
      coachId: "",
      resourceId: prefill?.resourceId ?? "",
      date: prefill ? toDateInput(prefill.startAt) : "",
      startTime: prefill ? toTimeInput(prefill.startAt) : "09:00",
      endTime: prefill ? toTimeInput(prefill.endAt) : "10:00",
      useType: "",
      note: "",
    };
  }, [prefill, sessionState]);

  const blockDefaults = useMemo(() => {
    if (!blockState.ok && blockState.values) return blockState.values;
    return {
      resourceId: prefill?.resourceId ?? "",
      date: prefill ? toDateInput(prefill.startAt) : "",
      startTime: prefill ? toTimeInput(prefill.startAt) : "09:00",
      endTime: prefill ? toTimeInput(prefill.endAt) : "10:00",
      reason: "",
    };
  }, [prefill, blockState]);

  return (
    <dialog
      ref={dialogRef}
      className="m-auto w-full max-w-lg rounded-lg border border-line bg-surface text-fg p-0 backdrop:bg-page/70 backdrop:backdrop-blur-sm"
    >
      <div className="p-6 space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.14em] text-fg-muted">
              New
            </p>
            <h2 className="text-xl font-semibold tracking-tight mt-0.5">
              {tab === "session" ? "Session" : "Block"}
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

        {/* Tab toggle */}
        <div
          role="tablist"
          className="inline-flex rounded-md border border-line bg-page p-0.5"
        >
          <TabButton
            active={tab === "session"}
            onClick={() => setTab("session")}
            label="Session"
            hint="A coach booking"
          />
          <TabButton
            active={tab === "block"}
            onClick={() => setTab("block")}
            label="Block"
            hint="Camp / team / repair"
          />
        </div>

        {tab === "session" ? (
          <SessionTab
            action={sessionAction}
            state={sessionState}
            pending={sessionPending}
            defaults={sessionDefaults}
            coaches={coaches}
            resources={resources}
            onCancel={onClose}
          />
        ) : (
          <BlockTab
            action={blockAction}
            state={blockState}
            pending={blockPending}
            defaults={blockDefaults}
            resources={resources}
            onCancel={onClose}
          />
        )}
      </div>
    </dialog>
  );
}

function TabButton({
  active,
  onClick,
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  hint: string;
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      type="button"
      onClick={onClick}
      className={[
        "rounded px-3 py-1.5 text-sm transition-colors",
        active
          ? "bg-gold text-gold-ink font-semibold"
          : "text-fg-muted hover:text-fg",
      ].join(" ")}
      title={hint}
    >
      {label}
    </button>
  );
}

function SessionTab({
  action,
  state,
  pending,
  defaults,
  coaches,
  resources,
  onCancel,
}: {
  action: (formData: FormData) => void;
  state: SessionActionResult;
  pending: boolean;
  defaults: {
    coachId: string;
    resourceId: string;
    date: string;
    startTime: string;
    endTime: string;
    useType: string;
    note: string;
  };
  coaches: CoachOption[];
  resources: ResourceOption[];
  onCancel: () => void;
}) {
  // Include defaults in the key so changing prefill (a new cell click)
  // remounts the inputs with the new defaultValue. Without this the
  // form keeps the first prefill's values across cell clicks.
  const formKey = state.ok
    ? `session-${defaults.resourceId}-${defaults.date}-${defaults.startTime}`
    : `session-err-${state.error.code}-${state.error.message}`;

  return (
    <form action={action} key={formKey} className="space-y-3">
      {!state.ok ? (
        <div
          role="alert"
          className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
        >
          {state.error.message}
        </div>
      ) : null}

      <Field label="Coach">
        <select
          name="coachId"
          required
          defaultValue={defaults.coachId}
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

      <DateAndTimeRow defaults={defaults} />

      <Field
        label="Use type"
        hint="Required for cages (hitting or pitching). Leave blank for bullpens and weight rooms."
      >
        <select
          name="useType"
          defaultValue={defaults.useType}
          className={selectStyles}
        >
          <option value="">— None (bullpen / weight room)</option>
          <option value="hitting">Hitting</option>
          <option value="pitching">Pitching</option>
        </select>
      </Field>

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

      <FormButtons pending={pending} submitLabel="Create session" onCancel={onCancel} />
    </form>
  );
}

function BlockTab({
  action,
  state,
  pending,
  defaults,
  resources,
  onCancel,
}: {
  action: (formData: FormData) => void;
  state: BlockActionResult;
  pending: boolean;
  defaults: {
    resourceId: string;
    date: string;
    startTime: string;
    endTime: string;
    reason: string;
  };
  resources: ResourceOption[];
  onCancel: () => void;
}) {
  const formKey = state.ok
    ? `block-${defaults.resourceId}-${defaults.date}-${defaults.startTime}`
    : `block-err-${state.error.code}-${state.error.message}`;

  return (
    <form action={action} key={formKey} className="space-y-3">
      {!state.ok ? (
        <div
          role="alert"
          className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
        >
          {state.error.message}
        </div>
      ) : null}

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

      <DateAndTimeRow defaults={defaults} />

      <Field
        label="Reason"
        hint="Free text — e.g. 'Summer Camp Group 5', 'Team Hitting Lab', 'HVAC repair'. Shown in the grid."
      >
        <input
          type="text"
          name="reason"
          required
          maxLength={120}
          defaultValue={defaults.reason}
          placeholder="What's this block for?"
          className={inputStyles}
        />
      </Field>

      <FormButtons pending={pending} submitLabel="Create block" onCancel={onCancel} />
    </form>
  );
}

function DateAndTimeRow({
  defaults,
}: {
  defaults: { date: string; startTime: string; endTime: string };
}) {
  return (
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
        <input
          type="time"
          name="startTime"
          required
          step={1800}
          defaultValue={defaults.startTime}
          className={inputStyles}
        />
      </Field>
      <Field label="End">
        <input
          type="time"
          name="endTime"
          required
          step={1800}
          defaultValue={defaults.endTime}
          className={inputStyles}
        />
      </Field>
    </div>
  );
}

function FormButtons({
  pending,
  submitLabel,
  onCancel,
}: {
  pending: boolean;
  submitLabel: string;
  onCancel: () => void;
}) {
  return (
    <div className="flex items-center justify-end gap-2 pt-2">
      <button
        type="button"
        onClick={onCancel}
        className="rounded-md border border-line bg-surface-2 text-fg-muted hover:text-fg hover:border-line-strong h-9 px-4 text-sm font-medium transition-colors"
      >
        Cancel
      </button>
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-gold text-gold-ink hover:bg-gold-hover h-9 px-4 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
      >
        {pending ? "Saving…" : submitLabel}
      </button>
    </div>
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

function toDateInput(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function toTimeInput(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
