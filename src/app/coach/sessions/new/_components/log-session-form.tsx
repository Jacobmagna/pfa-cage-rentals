"use client";

import {
  useActionState,
  useMemo,
  useState,
  useTransition,
  type FormEvent,
} from "react";
import { ChevronDown, Plus } from "lucide-react";
import {
  logOwnSessionFormAction,
  type CoachActionResult,
} from "../form-actions";
import { logOwnSessionsBatch } from "../../actions";
import type { ResourceOption } from "../../_components/types";
import { CompletionPanel } from "@/app/_components/completion-panel";
import { TimeSelect } from "@/app/_components/time-select";
import { SessionFlagsRow } from "@/app/_components/session-flags-row";
import { SlotLengthToggle } from "@/app/_components/slot-length-toggle";
import {
  SessionSlotsList,
  deriveSlots,
  type SlotInput,
} from "@/app/_components/session-slots-list";
import { formatPfaDate, formatPfaTime, parsePfaInput } from "@/lib/timezone";
import { AvailabilityPanel } from "./availability-panel";

const INITIAL_STATE: CoachActionResult = { ok: true, loggedAt: 0 };

// Mobile-first single-column form. Two submission paths:
//   - Single slot (end - start === slotLength): form-action layer
//     handles the submit via useActionState. Existing tested path.
//   - Multi slot (end - start > slotLength): onSubmit intercepts,
//     calls logOwnSessionsBatch directly with the live slot array.
//     The slot list is controlled and N notecards render in place
//     of the single Note + TeamRental fields.
//
// Why two paths instead of one batch-only path: keeping the
// useActionState flow for the common N=1 case means we don't have
// to re-derive its "echo errored values back into the form on
// failure" behavior. Multi-slot errors do lose typed-per-slot
// notes on failure — accepted v1 trade-off; coach retypes.
export function LogSessionForm({
  resources,
}: {
  resources: ResourceOption[];
}) {
  const [state, formAction, pending] = useActionState(
    logOwnSessionFormAction,
    INITIAL_STATE,
  );

  // Multi-slot path has its own pending + result state — useActionState
  // only knows about the single-slot path.
  const [batchPending, startBatchTransition] = useTransition();
  const [batchResult, setBatchResult] = useState<
    | { status: "idle" }
    | { status: "success"; count: number; at: number }
    | { status: "error"; message: string }
  >({ status: "idle" });

  const cages = resources.filter((r) => r.type === "cage");
  const bullpens = resources.filter((r) => r.type === "bullpen");
  const weightRooms = resources.filter((r) => r.type === "weight_room");

  // Default field values (same as before).
  const defaults = useMemo(() => {
    if (!state.ok) {
      return state.values;
    }
    const start = roundDownToHalfHour(new Date());
    const startWall = toTimeInput(start);
    const inWindow = startWall >= "08:00" && startWall <= "21:30";
    const startTime = inWindow ? startWall : "09:00";
    const endTime = (() => {
      const [h, m] = startTime.split(":").map(Number);
      let endH = h + 1;
      let endM = m;
      if (endH > 22 || (endH === 22 && endM > 0)) {
        endH = 22;
        endM = 0;
      }
      return `${endH.toString().padStart(2, "0")}:${endM.toString().padStart(2, "0")}`;
    })();
    return {
      resourceId: "",
      date: toDateInput(start),
      startTime,
      endTime,
      useType: "",
      note: "",
      isTeamRental: false,
      pfaReferred: false,
      isOnline: false,
    };
  }, [state]);

  const showSingleError = !state.ok;
  const showBatchError = batchResult.status === "error";

  // Collapse-to-confirmation across BOTH success paths:
  //   - single slot → useActionState `state.loggedAt` (nonce + message
  //     "Session logged.")
  //   - batch        → `batchResult.at` (nonce + count → "{n} sessions
  //     logged.")
  // Unify into one `successNonce`; the batch path takes precedence when
  // freshly set (both never carry a meaningful state at once — each
  // submission path resets the other's transient state). Acking via the
  // panel's "Log another session" lands us on a FRESH blank form: the
  // single path already remounts via `formKey` (key includes loggedAt);
  // the batch path doesn't bump useActionState, so the ack also bumps
  // `resetNonce` which feeds `formKey` to force a clean remount (and the
  // batch submit already cleared slots + revealNotes). Ephemeral +
  // component-local so navigating away and back remounts to base. No
  // setState-in-effect (pure compare).
  const singleNonce = state.ok ? state.loggedAt : 0;
  const batchNonce = batchResult.status === "success" ? batchResult.at : 0;
  const successMessage =
    batchResult.status === "success"
      ? `${batchResult.count} sessions logged.`
      : "Session logged.";
  const successNonce = batchNonce > 0 ? batchNonce : singleNonce;
  const [ackedNonce, setAckedNonce] = useState(0);
  const [resetNonce, setResetNonce] = useState(0);
  const showDone = successNonce > 0 && successNonce !== ackedNonce;

  const formKey = state.ok
    ? state.loggedAt > 0
      ? `ok-${state.loggedAt}`
      : `fresh-${resetNonce}`
    : `err-${state.error.code}-${state.error.message}`;

  // Live state for the four "echoed" fields that the AvailabilityPanel
  // + slot computation both depend on.
  const [live, setLive] = useState({
    date: defaults.date,
    resourceId: defaults.resourceId,
    startTime: defaults.startTime,
    endTime: defaults.endTime,
  });
  const [prevDefaults, setPrevDefaults] = useState(defaults);
  if (defaults !== prevDefaults) {
    setPrevDefaults(defaults);
    setLive({
      date: defaults.date,
      resourceId: defaults.resourceId,
      startTime: defaults.startTime,
      endTime: defaults.endTime,
    });
  }

  // Slot length + computed slot count. Slot count = (end - start) /
  // length, validated for clean divisibility. If invalid (e.g. 4h15m
  // / 30min), count = 0 and we show an inline error.
  const [slotLengthMinutes, setSlotLengthMinutes] = useState<30 | 60>(30);
  const [slots, setSlots] = useState<SlotInput[]>([]);
  // Per-session notes editor is collapsed by default on multi-slot.
  // The coach reveals it on demand via a small affordance.
  const [revealNotes, setRevealNotes] = useState(false);
  const [useTypeValue, setUseTypeValue] = useState(defaults.useType);

  // Reset useType when defaults change (post-success or post-error reset).
  const [prevUseTypeDefault, setPrevUseTypeDefault] = useState(
    defaults.useType,
  );
  if (defaults.useType !== prevUseTypeDefault) {
    setPrevUseTypeDefault(defaults.useType);
    setUseTypeValue(defaults.useType);
  }

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

  const isMultiSlot = slotCount > 1;

  // CRITICAL: the parent OWNS slot derivation so `slots[]` is always
  // populated from (rangeStart, rangeEnd, slotLengthMinutes) whenever
  // the range is a valid multi-slot range — regardless of whether the
  // per-session notes editor is revealed. Without this, hiding
  // SessionSlotsList would leave `slots` empty and the
  // `if (slots.length === 0) return;` guard in handleSubmit would
  // silently block the batch submit.
  //
  // Derive during render (the repo's adjust-state-on-prop-change
  // pattern, same as prevDefaults/prevUseTypeDefault above) keyed by a
  // range signature — not an effect, which the lint config forbids for
  // setState. `deriveSlots` preserves any already-typed notes/flags
  // (matched by start/end signature), so per-session edits made while
  // the editor is open survive a range-signature-stable re-render and
  // flow into the batch submit. When the range/length changes we also
  // collapse the editor so a later multi-slot range starts collapsed.
  const rangeSig = `${rangeStart?.getTime() ?? "x"}|${rangeEnd?.getTime() ?? "x"}|${slotLengthMinutes}`;
  // Sentinel initial value so the FIRST render always derives — the
  // default range is a multi-slot span and the notes editor is
  // collapsed (unmounted) by default, so slots would otherwise be
  // empty on load and the batch submit guard would block.
  const [prevRangeSig, setPrevRangeSig] = useState(" init");
  if (rangeSig !== prevRangeSig) {
    setPrevRangeSig(rangeSig);
    setSlots((prior) =>
      deriveSlots(rangeStart, rangeEnd, slotLengthMinutes, prior),
    );
    if (prevRangeSig !== " init") setRevealNotes(false);
  }

  const submitLabel = (() => {
    if (pending || batchPending) return "Logging…";
    if (slotCount === 0) return "Log session";
    if (slotCount === 1) return "Log session";
    return `Log ${slotCount} sessions`;
  })();

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    if (!isMultiSlot) {
      // N=1 → let the form-action take over. Don't preventDefault.
      return;
    }
    // N>1 → take over the submit.
    e.preventDefault();
    if (slotCount === 0 || divisibilityError) return;
    if (slots.length === 0) return;

    setBatchResult({ status: "idle" });
    startBatchTransition(async () => {
      try {
        await logOwnSessionsBatch({
          resourceId: live.resourceId,
          useType:
            useTypeValue === "hitting" || useTypeValue === "pitching"
              ? useTypeValue
              : null,
          slots: slots.map((s) => ({
            startAt: s.startAt,
            endAt: s.endAt,
            note: s.note.trim() || null,
            isTeamRental: s.isTeamRental,
            pfaReferred: s.pfaReferred,
            isOnline: s.isOnline,
          })),
        });
        setBatchResult({
          status: "success",
          count: slots.length,
          at: Date.now(),
        });
        // Reset slot state for the next batch.
        setSlots([]);
        setRevealNotes(false);
        // Reset the form via the existing remount path: dispatch a no-op
        // to bump useActionState. Simpler: nudge live state and let the
        // useMemo "defaults" path naturally reset on the next render.
        // But we DON'T have a way to trigger useActionState's reset
        // from here. Acceptable: success banner stays + slots clear;
        // coach picks a new range to log another batch.
      } catch (err) {
        setBatchResult({
          status: "error",
          message: err instanceof Error ? err.message : "Batch create failed",
        });
      }
    });
  };

  // "Log another session" → ack the success and return to a FRESH blank
  // form. The single-slot path is reset by useActionState (new `state`
  // → `defaults` recompute → prevDefaults resets `live`/useType). The
  // batch path leaves `state` untouched, so we must reset the
  // parent-owned controlled state ourselves and bump `resetNonce`
  // (feeds `formKey`) to remount the form's uncontrolled fields. We use
  // the current `defaults` (blank on the fresh path) as the reset source.
  const handleAckSuccess = () => {
    if (batchNonce > 0) {
      setLive({
        date: defaults.date,
        resourceId: defaults.resourceId,
        startTime: defaults.startTime,
        endTime: defaults.endTime,
      });
      setUseTypeValue(defaults.useType);
      setSlotLengthMinutes(30);
      setSlots([]);
      setRevealNotes(false);
      setBatchResult({ status: "idle" });
      setResetNonce((n) => n + 1);
    }
    setAckedNonce(successNonce);
  };

  if (showDone) {
    return (
      <div className="space-y-4">
        <CompletionPanel
          message={successMessage}
          actionLabel="Log another session"
          onAction={handleAckSuccess}
        />
        <AvailabilityPanel
          resources={resources}
          date={live.date}
          resourceId={live.resourceId}
          onResourceChange={(id) =>
            setLive((p) => ({ ...p, resourceId: id }))
          }
          startTime={live.startTime}
          endTime={live.endTime}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {showSingleError ? (
        <div
          role="alert"
          className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger"
        >
          {state.error.message}
        </div>
      ) : null}

      {showBatchError ? (
        <div
          role="alert"
          className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger"
        >
          {batchResult.status === "error" ? batchResult.message : null}
        </div>
      ) : null}

      <form
        action={formAction}
        onSubmit={handleSubmit}
        key={formKey}
        className="space-y-5"
      >
        <Field label="Resource">
          <SelectWrapper>
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
          </SelectWrapper>
        </Field>

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

        <div className="grid grid-cols-2 gap-3">
          <Field label="Start">
            <SelectWrapper>
              <TimeSelect
                name="startTime"
                variant="start"
                required
                value={live.startTime}
                onChange={(v) => setLive((p) => ({ ...p, startTime: v }))}
                className={selectStyles}
              />
            </SelectWrapper>
          </Field>
          <Field label="End">
            <SelectWrapper>
              <TimeSelect
                name="endTime"
                variant="end"
                required
                value={live.endTime}
                onChange={(v) => setLive((p) => ({ ...p, endTime: v }))}
                className={selectStyles}
              />
            </SelectWrapper>
          </Field>
        </div>

        {/* Compact, clearly-secondary slot-length micro-control. Sits
            just under the Start/End row rather than as a full Field so
            it doesn't read as a peer of the time selectors. */}
        <div className="-mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[11px] uppercase tracking-wider text-fg-muted">
            Slot length
          </span>
          <SlotLengthToggle
            value={slotLengthMinutes}
            onChange={(v) => setSlotLengthMinutes(v)}
            size="sm"
          />
          <span
            className="text-[11px] text-fg-subtle leading-snug basis-full sm:basis-auto"
            title="30 min = back-to-back half-hour lessons. 1 hr = full hours."
          >
            30 min = back-to-back half-hour lessons. 1 hr = full hours.
          </span>
        </div>

        {divisibilityError ? (
          <div
            role="alert"
            className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
          >
            Range isn&apos;t a clean multiple of {slotLengthMinutes} min — pick
            different start/end times.
          </div>
        ) : null}

        {isMultiSlot && !divisibilityError ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <p className="text-xs text-fg-subtle">
              Will create{" "}
              <span className="text-fg tnum">{slotCount}</span> sessions of{" "}
              {slotLengthMinutes} min each.
            </p>
            {!revealNotes ? (
              <button
                type="button"
                onClick={() => setRevealNotes(true)}
                className="inline-flex items-center gap-1 text-xs font-medium text-fg-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 rounded transition-colors"
              >
                <Plus aria-hidden className="h-3.5 w-3.5" />
                Add per-session notes
              </button>
            ) : null}
          </div>
        ) : null}

        <Field
          label="Use type"
          hint="Required for cages (hitting or pitching). Leave blank for bullpens and weight rooms."
        >
          <SelectWrapper>
            <select
              name="useType"
              value={useTypeValue}
              onChange={(e) => setUseTypeValue(e.target.value)}
              className={selectStyles}
            >
              <option value="">— None (bullpen / weight room)</option>
              <option value="hitting">Hitting</option>
              <option value="pitching">Pitching</option>
            </select>
          </SelectWrapper>
        </Field>

        {!isMultiSlot ? (
          <>
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

            <SessionFlagsRow
              showTeamRental={false}
              defaults={{
                pfaReferred: defaults.pfaReferred,
                isOnline: defaults.isOnline,
              }}
            />
          </>
        ) : revealNotes ? (
          // Presentational-only: the parent owns derivation (see the
          // deriveSlots effect above), so we do NOT pass range props.
          // This keeps `slots[]` populated even when this editor is
          // collapsed, while edits here still flow back into `slots`.
          <SessionSlotsList
            slots={slots}
            onChange={setSlots}
            showTeamRental={false}
          />
        ) : null}

        <button
          type="submit"
          disabled={
            pending ||
            batchPending ||
            (isMultiSlot && (slotCount === 0 || divisibilityError))
          }
          className="w-full sm:w-auto rounded-lg bg-gold text-gold-ink hover:bg-gold-hover shadow-[var(--shadow-sm)] h-12 px-6 text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
        >
          {submitLabel}
        </button>
      </form>

      <AvailabilityPanel
        resources={resources}
        date={live.date}
        resourceId={live.resourceId}
        onResourceChange={(id) =>
          setLive((p) => ({ ...p, resourceId: id }))
        }
        startTime={live.startTime}
        endTime={live.endTime}
      />
    </div>
  );
}

// Wraps a <select> so a custom chevron overlays the input. `selectStyles`
// uses `appearance-none` for cross-browser styling consistency, but iOS
// Safari still rendered the native chevron at very low contrast against
// the dark background. This positioned icon replaces it.
function SelectWrapper({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative">
      {children}
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-fg-subtle"
      />
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
  "w-full rounded-lg bg-surface border border-line text-fg placeholder:text-fg-subtle px-3 h-12 text-base focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40";
const selectStyles = `${inputStyles} appearance-none pr-8`;

function roundDownToHalfHour(d: Date): Date {
  const copy = new Date(d.getTime());
  copy.setSeconds(0, 0);
  copy.setMinutes(copy.getMinutes() < 30 ? 0 : 30);
  return copy;
}

// Inputs render PFA wall-clock — same value regardless of viewer's browser TZ.
const toDateInput = formatPfaDate;
const toTimeInput = formatPfaTime;
