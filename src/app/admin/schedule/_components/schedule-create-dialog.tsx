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
  type ActionResult as SessionActionResult,
} from "@/app/admin/sessions/form-actions";
import { createSessionsBatch } from "@/app/admin/sessions/actions";
import type {
  CoachOption,
  ResourceOption,
} from "@/app/admin/sessions/_components/sessions-client";
import {
  createBlockFormAction,
  type BlockActionResult,
} from "../form-actions";
import { TimeSelect } from "@/app/_components/time-select";
import { TeamRentalCheckbox } from "@/app/_components/team-rental-checkbox";
import { SlotLengthToggle } from "@/app/_components/slot-length-toggle";
import {
  SessionSlotsList,
  type SlotInput,
} from "@/app/_components/session-slots-list";
import { formatPfaDate, formatPfaTime, parsePfaInput } from "@/lib/timezone";

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
  defaultTab = "session",
}: {
  open: boolean;
  onClose: () => void;
  coaches: CoachOption[];
  resources: ResourceOption[];
  prefill: CreatePrefill | null;
  /**
   * Which tab to land on when the dialog opens. The paint flow uses
   * "block" so an admin who just painted a range doesn't have to
   * manually switch tabs before typing the reason.
   */
  defaultTab?: "session" | "block";
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<"session" | "block">(defaultTab);

  // React 19 pattern for "reset internal state when a prop transitions":
  // store the previous `open` in state, compare during render, and
  // call setState conditionally. The effect-based version of this is
  // flagged by react-hooks/set-state-in-effect because it triggers a
  // second commit; this pattern collapses to a single render.
  //
  // We reset tab only on the open=false → open=true transition so
  // switching defaultTab mid-open doesn't yank the user off the tab
  // they're typing in.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open && !prevOpen) setTab(defaultTab);
  }

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
      isTeamRental: false,
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
    isTeamRental: boolean;
  };
  coaches: CoachOption[];
  resources: ResourceOption[];
  onCancel: () => void;
}) {
  // Controlled live state for fields that multi-slot math reads from.
  // Re-seeded whenever defaults change (new prefill or post-error).
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
  }

  const [slotLengthMinutes, setSlotLengthMinutes] = useState<30 | 60>(30);
  const [slots, setSlots] = useState<SlotInput[]>([]);
  const [batchPending, startBatchTransition] = useTransition();
  const [batchError, setBatchError] = useState<string | null>(null);

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
    if (totalMs <= 0)
      return {
        rangeStart: start,
        rangeEnd: end,
        slotCount: 0,
        divisibilityError: false,
      };
    if (totalMs % lengthMs !== 0)
      return {
        rangeStart: start,
        rangeEnd: end,
        slotCount: 0,
        divisibilityError: true,
      };
    return {
      rangeStart: start,
      rangeEnd: end,
      slotCount: totalMs / lengthMs,
      divisibilityError: false,
    };
  }, [live.date, live.startTime, live.endTime, slotLengthMinutes]);

  const isMultiSlot = slotCount > 1;

  const submitLabel = (() => {
    if (pending || batchPending) return "Saving…";
    if (slotCount > 1) return `Create ${slotCount} sessions`;
    return "Create session";
  })();

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    if (!isMultiSlot) return;
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
        onCancel();
      } catch (err) {
        setBatchError(
          err instanceof Error ? err.message : "Batch create failed",
        );
      }
    });
  };

  const formKey = state.ok
    ? `session-${defaults.resourceId}-${defaults.date}-${defaults.startTime}`
    : `session-err-${state.error.code}-${state.error.message}`;

  return (
    <form
      action={action}
      onSubmit={handleSubmit}
      key={formKey}
      className="space-y-3"
    >
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

      <Field label="Coach">
        <select
          name="coachId"
          required
          value={live.coachId}
          onChange={(e) => setLive((p) => ({ ...p, coachId: e.target.value }))}
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
          value={live.resourceId}
          onChange={(e) =>
            setLive((p) => ({ ...p, resourceId: e.target.value }))
          }
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
            value={live.date}
            onChange={(e) => setLive((p) => ({ ...p, date: e.target.value }))}
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

      <Field
        label="Slot length"
        hint="30 min = back-to-back half-hour lessons. 1 hr = full hours."
      >
        <SlotLengthToggle
          value={slotLengthMinutes}
          onChange={(v) => setSlotLengthMinutes(v)}
        />
      </Field>

      {divisibilityError ? (
        <div
          role="alert"
          className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
        >
          Range isn&apos;t a clean multiple of {slotLengthMinutes} min — pick
          different start/end times.
        </div>
      ) : null}

      {slotCount > 0 && !divisibilityError ? (
        <p className="text-xs text-fg-subtle">
          Will create <span className="text-fg">{slotCount}</span>{" "}
          {slotCount === 1 ? "session" : "sessions"} of {slotLengthMinutes} min
          each.
        </p>
      ) : null}

      <Field
        label="Use type"
        hint="Required for cages (hitting or pitching). Leave blank for bullpens and weight rooms."
      >
        <select
          name="useType"
          value={live.useType}
          onChange={(e) => setLive((p) => ({ ...p, useType: e.target.value }))}
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

      <FormButtons
        pending={pending || batchPending}
        submitLabel={submitLabel}
        onCancel={onCancel}
        disabled={isMultiSlot && (slotCount === 0 || divisibilityError)}
      />
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
  );
}

function FormButtons({
  pending,
  submitLabel,
  onCancel,
  disabled = false,
}: {
  pending: boolean;
  submitLabel: string;
  onCancel: () => void;
  disabled?: boolean;
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
        disabled={pending || disabled}
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

// Inputs render PFA wall-clock — same value regardless of viewer's browser TZ.
const toDateInput = formatPfaDate;
const toTimeInput = formatPfaTime;
