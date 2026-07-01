"use client";

import {
  forwardRef,
  useActionState,
  useEffect,
  useImperativeHandle,
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
import { createBlockSeries, createBlocksBatch } from "../actions";
import {
  FREQUENCY_OPTIONS,
  freqIntervalForKind,
  monthlyHint,
  weekdayFromIso,
  type FrequencyKind,
} from "@/app/admin/hour-log/schedule/_components/recurrence-frequency.logic";
import type { BlockBatchResult } from "@/lib/server/block-series-actions";
import { TimeSelect } from "@/app/_components/time-select";
import { DateInput } from "@/app/_components/date-input";
import { SlotLengthToggle } from "@/app/_components/slot-length-toggle";
import {
  SessionSlotsList,
  type SlotInput,
} from "@/app/_components/session-slots-list";
import { formatPfaDate, formatPfaTime, parsePfaInput } from "@/lib/timezone";

// Unified "create on the grid" dialog. Two tabs:
//   - Session: full session form (coach dropdown + note)
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

  // Auto-close on successful session submit. (The Block tab manages its own
  // submit + close internally — it's fully client-driven now, no form action.)
  const wasSessionPending = useRef(false);
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
      note: "",
    };
  }, [prefill, sessionState]);

  const blockDefaults = useMemo(
    () => ({
      resourceId: prefill?.resourceId ?? "",
      date: prefill ? toDateInput(prefill.startAt) : "",
      startTime: prefill ? toTimeInput(prefill.startAt) : "09:00",
      endTime: prefill ? toTimeInput(prefill.endAt) : "10:00",
      reason: "",
    }),
    [prefill],
  );

  return (
    <dialog
      ref={dialogRef}
      className="m-auto w-full max-w-lg rounded-xl border border-line bg-surface text-fg p-0 shadow-[var(--shadow-lg)] backdrop:bg-page/70 backdrop:backdrop-blur-sm"
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
    note: string;
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
    });
  }

  const [slotLengthMinutes, setSlotLengthMinutes] = useState<number>(30);
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
          slots: slots.map((s) => ({
            startAt: s.startAt,
            endAt: s.endAt,
            note: s.note.trim() || null,
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
          <DateInput
            name="date"
            required
            value={live.date}
            onChange={(iso) => setLive((p) => ({ ...p, date: iso }))}
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

      {!isMultiSlot ? (
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

const WEEKDAY_PILLS = [
  { i: 0, label: "S" },
  { i: 1, label: "M" },
  { i: 2, label: "T" },
  { i: 3, label: "W" },
  { i: 4, label: "T" },
  { i: 5, label: "F" },
  { i: 6, label: "S" },
] as const;

// ── MULTI-CAGE Block tab ──────────────────────────────────────────────────
// Blocks one OR MANY resources at once. With ≥2 selected, "Set each cage
// separately" splits the one form into N stacked sub-forms (each cage gets its
// own date/time/reason/repeat), saved together. One-off → createBlocksBatch;
// recurring → createBlockSeries. Both apply skip-and-continue per (cage, date)
// and the results are aggregated into one report.

type BlockDefaults = {
  resourceId: string;
  date: string;
  startTime: string;
  endTime: string;
  reason: string;
};

type BlockFieldInitial = Omit<BlockDefaults, "resourceId">;

// The resolved values of one BlockFields sub-form (+ derived recurrence).
type BlockFieldValues = {
  date: string;
  startTime: string;
  endTime: string;
  reason: string;
  repeats: boolean;
  frequency: "weekly" | "monthly";
  interval: number;
  daysOfWeek: number[];
  endsOn: string;
};

type BlockFieldsHandle = {
  getValues: () => BlockFieldValues;
  validate: () => string | null;
};

function BlockTab({
  defaults,
  resources,
  onCancel,
}: {
  defaults: BlockDefaults;
  resources: ResourceOption[];
  onCancel: () => void;
}) {
  // Selected resources (multi). Seeded from the clicked cell's resource.
  const [resourceIds, setResourceIds] = useState<string[]>(
    defaults.resourceId ? [defaults.resourceId] : [],
  );
  // "Set each cage separately" — only meaningful with ≥2 cages selected.
  const [independent, setIndependent] = useState(false);
  // When flipping to independent, seed each cage's sub-form from what was typed
  // in the unified form so the admin edits from a filled starting point.
  const [carry, setCarry] = useState<BlockFieldInitial | null>(null);
  const [prevDefaults, setPrevDefaults] = useState(defaults);

  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BlockBatchResult | null>(null);

  if (defaults !== prevDefaults) {
    setPrevDefaults(defaults);
    setResourceIds(defaults.resourceId ? [defaults.resourceId] : []);
    setIndependent(false);
    setCarry(null);
    setError(null);
    setResult(null);
  }

  const multi = resourceIds.length >= 2;
  const useIndependent = multi && independent;

  // Selected resources in the grid's display order (resources is sorted).
  const selected = useMemo(
    () => resources.filter((r) => resourceIds.includes(r.id)),
    [resources, resourceIds],
  );

  // Refs to collect each sub-form's values on submit. Unified mode uses ONE
  // (keyed "unified"); independent mode uses one per selected cage id.
  const fieldRefs = useRef<Record<string, BlockFieldsHandle | null>>({});

  const toggleResource = (id: string) => {
    setError(null);
    setResourceIds((prev) =>
      prev.includes(id) ? prev.filter((r) => r !== id) : [...prev, id],
    );
  };

  const fieldsInitial: BlockFieldInitial = {
    date: defaults.date,
    startTime: defaults.startTime,
    endTime: defaults.endTime,
    reason: defaults.reason,
  };

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    if (resourceIds.length === 0) {
      setError("Pick at least one cage.");
      return;
    }

    // Build the operations: independent → one per cage (each with its own
    // fields); unified → one op covering all selected cages.
    type Op = { resourceIds: string[]; values: BlockFieldValues };
    let ops: Op[];
    if (useIndependent) {
      for (const r of selected) {
        const h = fieldRefs.current[r.id];
        if (!h) {
          setError("Something went wrong — reopen the dialog and try again.");
          return;
        }
        // validate() returns null when VALID — do NOT `?? fallback` it (null ??
        // "x" === "x" would block every valid submit).
        const err = h.validate();
        if (err) {
          setError(`${r.name}: ${err}`);
          return;
        }
      }
      ops = selected.map((r) => ({
        resourceIds: [r.id],
        values: fieldRefs.current[r.id]!.getValues(),
      }));
    } else {
      const handle = fieldRefs.current.unified;
      if (!handle) {
        setError("Something went wrong — reopen the dialog and try again.");
        return;
      }
      const err = handle.validate();
      if (err) {
        setError(err);
        return;
      }
      ops = [{ resourceIds, values: handle.getValues() }];
    }

    startTransition(async () => {
      try {
        let created = 0;
        const skippedRentals: BlockBatchResult["skippedRentals"] = [];
        let skippedBlocked = 0;
        for (const op of ops) {
          const v = op.values;
          if (v.repeats) {
            const res = await createBlockSeries({
              resourceIds: op.resourceIds,
              reason: v.reason.trim(),
              daysOfWeek: v.daysOfWeek,
              startTime: v.startTime,
              endTime: v.endTime,
              startsOn: v.date,
              endsOn: v.endsOn,
              frequency: v.frequency,
              interval: v.interval,
            });
            created += res.created;
            skippedRentals.push(...res.skippedRentals);
            skippedBlocked += res.skippedBlocked;
          } else {
            const res = await createBlocksBatch({
              resourceIds: op.resourceIds,
              startAt: parsePfaInput(v.date, v.startTime),
              endAt: parsePfaInput(v.date, v.endTime),
              reason: v.reason.trim(),
            });
            created += res.created;
            skippedRentals.push(...res.skippedRentals);
            skippedBlocked += res.skippedBlocked;
          }
        }
        setResult({ created, skippedRentals, skippedBlocked });
        // Clean success (blocked everything, nothing skipped) → close. If
        // anything was skipped, keep the dialog open so the admin reads it.
        if (created > 0 && skippedRentals.length === 0) onCancel();
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to create the block(s).",
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

      {multi ? (
        <label className="flex items-start gap-2.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={independent}
            onChange={(e) => {
              const next = e.target.checked;
              if (next) {
                // Snapshot the unified form so each cage starts pre-filled.
                const v = fieldRefs.current.unified?.getValues();
                if (v) {
                  setCarry({
                    date: v.date,
                    startTime: v.startTime,
                    endTime: v.endTime,
                    reason: v.reason,
                  });
                }
              }
              setIndependent(next);
              setResult(null);
              setError(null);
            }}
            className="mt-0.5 h-4 w-4 rounded border-line text-gold focus-visible:ring-2 focus-visible:ring-gold/40"
          />
          <span className="text-sm">
            <span className="font-medium text-fg">Set each cage separately</span>
            <span className="block text-[11px] text-fg-subtle leading-snug">
              Give each cage its own date, time &amp; repeat settings.
            </span>
          </span>
        </label>
      ) : null}

      {useIndependent ? (
        <div className="space-y-3">
          {selected.map((r) => (
            <div
              key={r.id}
              className="rounded-lg border border-line bg-page/40 p-3.5 space-y-3"
            >
              <p className="text-xs font-semibold uppercase tracking-wider text-gold-strong">
                {r.name}
              </p>
              <BlockFields
                ref={(h) => {
                  fieldRefs.current[r.id] = h;
                }}
                initial={carry ?? fieldsInitial}
              />
            </div>
          ))}
        </div>
      ) : (
        <BlockFields
          ref={(h) => {
            fieldRefs.current.unified = h;
          }}
          initial={fieldsInitial}
        />
      )}

      {result ? <BlockReport result={result} /> : null}

      {result && result.created > 0 ? (
        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md bg-gold text-gold-ink shadow-[var(--shadow-sm)] hover:bg-gold-hover h-9 px-4 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
          >
            Done
          </button>
        </div>
      ) : (
        <FormButtons
          pending={pending}
          submitLabel={
            pending
              ? "Saving…"
              : useIndependent
                ? `Create ${selected.length} blocks`
                : "Create block"
          }
          onCancel={onCancel}
          disabled={resourceIds.length === 0}
        />
      )}
    </form>
  );
}

// Multi-select resource picker, grouped by type (Cages / Bullpens / Weight
// room) — mirrors the work-schedule "Occupies cage resources" control.
const BLOCK_RESOURCE_TYPE_LABELS: Record<ResourceOption["type"], string> = {
  cage: "Cages",
  bullpen: "Bullpens",
  weight_room: "Weight room",
};
const BLOCK_RESOURCE_TYPE_ORDER: ResourceOption["type"][] = [
  "cage",
  "bullpen",
  "weight_room",
];

function CagePicker({
  resources,
  selected,
  onToggle,
}: {
  resources: ResourceOption[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  const selectedSet = new Set(selected);
  const groups = BLOCK_RESOURCE_TYPE_ORDER.map((type) => ({
    type,
    items: resources.filter((r) => r.type === type),
  })).filter((g) => g.items.length > 0);

  return (
    <div>
      <span className="text-xs uppercase tracking-wider text-fg-muted block mb-1.5">
        Resources{selected.length > 1 ? ` · ${selected.length} selected` : ""}
      </span>
      <div className="space-y-2.5 rounded-md border border-line bg-page/50 p-3">
        {groups.map((g) => (
          <div key={g.type}>
            <span className="text-[10px] uppercase tracking-wider text-fg-subtle block mb-1">
              {BLOCK_RESOURCE_TYPE_LABELS[g.type]}
            </span>
            <div className="flex flex-wrap gap-1.5">
              {g.items.map((r) => {
                const on = selectedSet.has(r.id);
                return (
                  <label
                    key={r.id}
                    className={[
                      "inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border text-xs font-medium cursor-pointer select-none transition-colors focus-within:outline-none focus-within:ring-2 focus-within:ring-gold/40",
                      on
                        ? "bg-gold/10 border-gold/40 text-gold-strong"
                        : "border-line text-fg-muted hover:text-fg hover:border-line-strong",
                    ].join(" ")}
                  >
                    <input
                      type="checkbox"
                      checked={on}
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
    </div>
  );
}

// One block's date/time/reason + Repeats + recurrence controls. Owns its state
// internally and exposes getValues()/validate() via ref so the parent can
// collect every sub-form on a single Save. Rendered once (unified) or N times
// (independent, one per cage). The resource itself is chosen in CagePicker.
const BlockFields = forwardRef<BlockFieldsHandle, { initial: BlockFieldInitial }>(
  function BlockFields({ initial }, ref) {
    const [live, setLive] = useState({
      date: initial.date,
      startTime: initial.startTime,
      endTime: initial.endTime,
      reason: initial.reason,
    });
    const [repeats, setRepeats] = useState(false);
    const [freqKind, setFreqKind] = useState<FrequencyKind>("weekly");
    const [everyN, setEveryN] = useState(3);
    const [pillsTouched, setPillsTouched] = useState(false);
    const [daysOfWeek, setDaysOfWeek] = useState<number[]>([]);
    const [endsOn, setEndsOn] = useState("");

    // Weekday pills default to the chosen date's weekday until the admin
    // toggles one (then they own the set). Monthly derives its weekday from
    // the start date, so we submit the date's weekday there. Memoized so the
    // useImperativeHandle below keeps a stable identity between renders.
    const dateWeekday = weekdayFromIso(live.date);
    const isMonthly = freqKind === "monthly";
    const submitDays = useMemo(() => {
      const effective = pillsTouched
        ? daysOfWeek
        : dateWeekday !== null
          ? [dateWeekday]
          : [];
      return isMonthly && dateWeekday !== null ? [dateWeekday] : effective;
    }, [pillsTouched, daysOfWeek, dateWeekday, isMonthly]);

    const toggleDay = (i: number) => {
      const base = pillsTouched
        ? daysOfWeek
        : dateWeekday !== null
          ? [dateWeekday]
          : [];
      setPillsTouched(true);
      setDaysOfWeek(
        base.includes(i) ? base.filter((d) => d !== i) : [...base, i].sort(),
      );
    };

    useImperativeHandle(
      ref,
      () => ({
        getValues: () => {
          const { frequency, interval } = freqIntervalForKind(freqKind, everyN);
          return {
            date: live.date,
            startTime: live.startTime,
            endTime: live.endTime,
            reason: live.reason,
            repeats,
            frequency,
            interval,
            daysOfWeek: submitDays,
            endsOn,
          };
        },
        validate: () => {
          if (!live.date) return "Pick a date";
          if (!live.reason.trim()) return "Enter a reason";
          if (!live.startTime || !live.endTime) return "Pick a time";
          if (live.startTime >= live.endTime) return "Start must be before end";
          if (repeats) {
            if (!endsOn) return "Pick a 'repeats until' date";
            if (submitDays.length === 0) return "Pick at least one weekday";
          }
          return null;
        },
      }),
      [live, repeats, freqKind, everyN, submitDays, endsOn],
    );

    return (
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-3">
          <Field label={repeats ? "Starts" : "Date"}>
            <DateInput
              required
              value={live.date}
              onChange={(iso) => setLive((p) => ({ ...p, date: iso }))}
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
          label="Reason"
          hint="Free text — e.g. 'Summer Camp Group 5', 'Team Hitting Lab', 'HVAC repair'. Shown in the grid."
        >
          <input
            type="text"
            required
            maxLength={120}
            value={live.reason}
            onChange={(e) => setLive((p) => ({ ...p, reason: e.target.value }))}
            placeholder="What's this block for?"
            className={inputStyles}
          />
        </Field>

        <label className="flex items-center gap-2.5 pt-1 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={repeats}
            onChange={(e) => setRepeats(e.target.checked)}
            className="h-4 w-4 rounded border-line text-gold focus-visible:ring-2 focus-visible:ring-gold/40"
          />
          <span className="text-sm font-medium text-fg">Repeats</span>
        </label>

        {repeats ? (
          <div className="rounded-lg border border-line bg-page/50 p-3.5 space-y-3">
            <Field label="Frequency">
              <select
                value={freqKind}
                onChange={(e) => setFreqKind(e.target.value as FrequencyKind)}
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
                  onChange={(e) => setEveryN(Number(e.target.value))}
                  className={inputStyles}
                />
              </Field>
            ) : null}

            {isMonthly ? (
              <p className="text-xs text-fg-muted">
                {monthlyHint(live.date) || "Pick a start date to set the pattern."}
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

            <Field
              label="Repeats until"
              hint="Last date the block can occur (inclusive)."
            >
              <DateInput
                required
                value={endsOn}
                onChange={(iso) => setEndsOn(iso)}
                className={inputStyles}
              />
            </Field>
          </div>
        ) : null}
      </div>
    );
  },
);

// Combined skip-and-continue report after a create (one-off or recurring, one
// or many cages). `created` counts materialized blocks across all cages.
function BlockReport({ result }: { result: BlockBatchResult }) {
  return (
    <div
      className={[
        "rounded-md border px-3 py-2.5 text-xs space-y-1.5",
        result.created === 0
          ? "border-danger/30 bg-danger/10 text-danger"
          : "border-line-strong bg-surface-2 text-fg",
      ].join(" ")}
    >
      <p className="font-semibold">
        {result.created === 0
          ? "Couldn't block anything — all conflicted."
          : `Blocked ${result.created} slot${result.created === 1 ? "" : "s"}.`}
      </p>
      {result.skippedRentals.length > 0 ? (
        <div className="space-y-0.5">
          <p className="text-fg-muted">
            Skipped {result.skippedRentals.length} (already rented):
          </p>
          <ul className="list-disc pl-4 text-fg-muted">
            {result.skippedRentals.map((s) => (
              <li key={s.label}>{s.label}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {result.skippedBlocked > 0 ? (
        <p className="text-fg-muted">
          {result.skippedBlocked} already blocked (skipped).
        </p>
      ) : null}
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
        className="rounded-md bg-gold text-gold-ink shadow-[var(--shadow-sm)] hover:bg-gold-hover h-9 px-4 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
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
