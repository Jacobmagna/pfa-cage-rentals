"use client";

// Calendly-style cage calendar — the MAIN coach booking surface on
// /coach/sessions/new. Resource rows × 30-min slot columns, 8 AM–10 PM,
// for ONE selected day (with prev/next/today nav).
//
// Per-cell coloring:
//   green  = bookable (free)        → click → booking panel
//   gold   = the coach's OWN session → click → read-only "your booking"
//   red    = taken (other coach) OR blocked → click → reveals ONLY the
//            booking coach's first name or the block reason, nothing else
//
// Single-slot only (this is W3.5a). Slot identity is kept as
// `${resourceId}|${slotIndex}` so W3.5b can layer batch multi-select on
// top without reworking the grid. The per-slot decision + the 1-hr rule
// live in the pure, unit-tested @/lib/coach-calendar helper.
//
// Availability is fetched from getDayAvailability on mount + whenever
// the selected day changes (a genuine side-effect → useEffect +
// useTransition; the lint config only forbids setState-in-effect for
// DERIVED state, not for real fetches).

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { Check, ChevronLeft, ChevronRight, Loader2, X } from "lucide-react";
import type { ResourceOption } from "../../_components/types";
import {
  getDayAvailability,
  type DayAvailability,
} from "../availability-actions";
import {
  canBookOneHour,
  computeSlotState,
  type SlotBlock,
  type SlotOccupant,
  type SlotSession,
  type SlotState,
} from "@/lib/coach-calendar";
import {
  SCHEDULE_GRID_FIRST_HOUR,
  SCHEDULE_GRID_SLOTS,
  formatGridHour,
} from "@/lib/schedule-grid-utils";
import {
  formatPfaDate,
  formatPfaDateLong,
  pfaDayStart,
  pfaWallClockAt,
} from "@/lib/timezone";
import { CageSlotBooking } from "./cage-slot-booking";
import { CageBatchBooking } from "./cage-batch-booking";

// Local copies of the schedule-grid type-stripe helper — duplicated per
// the prompt (don't import from the interactive admin grid).
function typeStripe(type: ResourceOption["type"]): string {
  switch (type) {
    case "cage":
      return "bg-gold";
    case "bullpen":
      return "bg-success";
    case "weight_room":
      return "bg-warning";
  }
}

// Slot index → its [startHour, startMinute].
function slotHourMinute(slotIndex: number): { hour: number; minute: number } {
  return {
    hour: SCHEDULE_GRID_FIRST_HOUR + Math.floor(slotIndex / 2),
    minute: (slotIndex % 2) * 30,
  };
}

type SelectedSlot = {
  resourceId: string;
  slotIndex: number;
};

export function CageCalendar({
  resources,
  coachId,
  coachName,
}: {
  resources: ResourceOption[];
  coachId: string;
  /** Display name — only used for the "your booking" read-only label. */
  coachName: string;
}) {
  const [selectedDate, setSelectedDate] = useState<Date>(() =>
    pfaDayStart(new Date()),
  );
  const [data, setData] = useState<DayAvailability | null>(null);
  const [pending, startTransition] = useTransition();
  const fetchSeq = useRef(0);

  // Selected GREEN slot → booking panel. `null` = no panel open.
  const [selected, setSelected] = useState<SelectedSlot | null>(null);
  // Tapped non-green slot → small inline reveal of occupant label.
  const [revealed, setRevealed] = useState<SelectedSlot | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);

  // ── Batch multi-select (W3.5b) ───────────────────────────────────
  // When ON, tapping green slots builds a selection scoped to ONE
  // resource row (the batch action is single-resource + shared useType).
  // A cross-resource tap RESETS the selection to that new resource.
  const [multiSelect, setMultiSelect] = useState(false);
  const [selection, setSelection] = useState<{
    resourceId: string | null;
    slotIndexes: Set<number>;
  }>({ resourceId: null, slotIndexes: new Set() });
  // Whether the batch booking form is open for the current selection.
  const [batchOpen, setBatchOpen] = useState(false);

  const dateStr = formatPfaDate(selectedDate);

  const refresh = useCallback((date: string) => {
    const seq = ++fetchSeq.current;
    startTransition(async () => {
      try {
        const result = await getDayAvailability(date);
        if (seq === fetchSeq.current) setData(result);
      } catch {
        // Best-effort. A transient failure leaves the prior snapshot in
        // place; the coach can still nudge the day to retry.
      }
    });
  }, []);

  // Real side-effect: fetch availability on mount + whenever the day
  // changes. (Not derived state → useEffect is the right tool.)
  useEffect(() => {
    refresh(dateStr);
  }, [refresh, dateStr]);

  const clearSelection = () => {
    setSelection({ resourceId: null, slotIndexes: new Set() });
    setBatchOpen(false);
  };

  const resetTransient = () => {
    setSelected(null);
    setRevealed(null);
    setConfirmation(null);
    clearSelection();
  };

  const goPrevDay = () => {
    resetTransient();
    setSelectedDate((d) => pfaDayStart(new Date(d.getTime() - 12 * 60 * 60 * 1000)));
  };
  const goNextDay = () => {
    resetTransient();
    setSelectedDate((d) => pfaDayStart(new Date(d.getTime() + 36 * 60 * 60 * 1000)));
  };
  const goToday = () => {
    resetTransient();
    setSelectedDate(pfaDayStart(new Date()));
  };

  // Per-resource reduced session/block ms ranges, keyed by resourceId.
  const sessionsByResource = new Map<string, SlotSession[]>();
  const blocksByResource = new Map<string, SlotBlock[]>();
  for (const r of resources) {
    sessionsByResource.set(r.id, []);
    blocksByResource.set(r.id, []);
  }
  for (const s of data?.sessions ?? []) {
    const arr = sessionsByResource.get(s.resourceId);
    if (!arr) continue;
    arr.push({
      startMs: new Date(s.startAt).getTime(),
      endMs: new Date(s.endAt).getTime(),
      coachFirstName: s.coachFirstName,
      isOwn: s.coachId === coachId,
    });
  }
  for (const b of data?.blocks ?? []) {
    const arr = blocksByResource.get(b.resourceId);
    if (!arr) continue;
    arr.push({
      startMs: new Date(b.startAt).getTime(),
      endMs: new Date(b.endAt).getTime(),
      reason: b.reason,
    });
  }

  // State of every (resource, slot) for this day. Computed once per
  // render so the 1-hr rule can read neighbor states without recompute.
  const slotStateFor = (resourceId: string, slotIndex: number) => {
    const { hour, minute } = slotHourMinute(slotIndex);
    const start = pfaWallClockAt(selectedDate, hour, minute);
    const slotStartMs = start.getTime();
    const slotEndMs = slotStartMs + 30 * 60_000;
    return computeSlotState({
      slotStartMs,
      slotEndMs,
      sessions: sessionsByResource.get(resourceId) ?? [],
      blocks: blocksByResource.get(resourceId) ?? [],
    });
  };

  const gridStyle: React.CSSProperties = {
    gridTemplateColumns: `120px repeat(${SCHEDULE_GRID_SLOTS}, minmax(34px, 1fr))`,
    gridTemplateRows: `40px repeat(${resources.length}, 48px)`,
  };

  const selectedResource = selected
    ? resources.find((r) => r.id === selected.resourceId) ?? null
    : null;

  // Active batch-selection resource + count (derived during render).
  const selectionResource = selection.resourceId
    ? resources.find((r) => r.id === selection.resourceId) ?? null
    : null;
  const selectionCount = selection.slotIndexes.size;

  // Whether the selected slot can be booked for a full hour (this slot
  // free AND next free AND next in-window).
  const selectedCanBookHour =
    selected && selectedResource
      ? canBookOneHour({
          slotIndex: selected.slotIndex,
          totalSlots: SCHEDULE_GRID_SLOTS,
          slotState: (i) => slotStateFor(selected.resourceId, i).state,
        })
      : false;

  const handleBooked = () => {
    setSelected(null);
    setConfirmation("Session logged. The slot is now yours (gold).");
    refresh(dateStr);
  };

  // Batch submit succeeded → clear the selection, confirm, re-fetch so
  // the booked slots flip to gold. Stays in multi-select mode.
  const handleBatchBooked = (count: number) => {
    clearSelection();
    setConfirmation(
      `${count} ${count === 1 ? "session" : "sessions"} logged. Those slots are now yours (gold).`,
    );
    refresh(dateStr);
  };

  // Toggle multi-select. Turning it OFF clears any in-progress selection;
  // turning it ON closes any open single-slot panel / reveal.
  const toggleMultiSelect = () => {
    setConfirmation(null);
    setMultiSelect((on) => {
      if (on) {
        // turning OFF
        clearSelection();
      } else {
        // turning ON
        setSelected(null);
        setRevealed(null);
      }
      return !on;
    });
  };

  // Toggle a green slot in the batch selection. A tap on a slot whose
  // resource differs from the active one (with a non-empty set) RESETS
  // the selection to that new resource — one active resource at a time.
  const toggleSelectSlot = (resourceId: string, slotIndex: number) => {
    setBatchOpen(false);
    setSelection((prev) => {
      // Different resource than the active selection → reset to the new
      // resource with just this slot.
      if (prev.resourceId !== null && prev.resourceId !== resourceId) {
        return { resourceId, slotIndexes: new Set([slotIndex]) };
      }
      const next = new Set(prev.slotIndexes);
      if (next.has(slotIndex)) next.delete(slotIndex);
      else next.add(slotIndex);
      return {
        resourceId: next.size === 0 ? null : resourceId,
        slotIndexes: next,
      };
    });
  };

  const handleSlotClick = (
    resourceId: string,
    slotIndex: number,
    state: SlotState,
  ) => {
    setConfirmation(null);
    // Batch mode: green slots build the multi-selection; red/gold still
    // reveal their occupant label (no selection).
    if (multiSelect) {
      if (state === "free") {
        setRevealed(null);
        toggleSelectSlot(resourceId, slotIndex);
        return;
      }
      setRevealed((prev) =>
        prev && prev.resourceId === resourceId && prev.slotIndex === slotIndex
          ? null
          : { resourceId, slotIndex },
      );
      return;
    }
    if (state === "free") {
      setRevealed(null);
      setSelected({ resourceId, slotIndex });
      return;
    }
    // own / taken / blocked → reveal label only, no booking.
    setSelected(null);
    setRevealed((prev) =>
      prev && prev.resourceId === resourceId && prev.slotIndex === slotIndex
        ? null
        : { resourceId, slotIndex },
    );
  };

  return (
    <div className="space-y-4">
      {/* Day nav. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={goPrevDay}
            aria-label="Previous day"
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-surface text-fg-muted hover:text-fg hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={goNextDay}
            aria-label="Next day"
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-surface text-fg-muted hover:text-fg hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          <div className="ml-1">
            <p className="text-sm font-semibold text-fg">
              {formatPfaDateLong(selectedDate)}
            </p>
          </div>
          {pending ? (
            <Loader2
              aria-label="Loading availability"
              className="h-3.5 w-3.5 text-fg-subtle animate-spin"
            />
          ) : null}
        </div>
        <button
          type="button"
          onClick={goToday}
          className="rounded-lg border border-line bg-surface px-3 h-9 text-xs font-medium text-fg-muted hover:text-fg hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
        >
          Today
        </button>
      </div>

      {/* Multi-select toggle. ON → tap several green slots → one batch. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={toggleMultiSelect}
          aria-pressed={multiSelect}
          className={[
            "inline-flex items-center gap-2 rounded-lg border px-3 h-9 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40",
            multiSelect
              ? "border-gold/50 bg-gold/10 text-gold-strong"
              : "border-line bg-surface text-fg-muted hover:text-fg hover:border-line-strong",
          ].join(" ")}
        >
          <span
            aria-hidden
            className={[
              "inline-flex h-4 w-4 items-center justify-center rounded border",
              multiSelect
                ? "border-gold bg-gold text-gold-ink"
                : "border-line-strong bg-surface",
            ].join(" ")}
          >
            {multiSelect ? <Check className="h-3 w-3" /> : null}
          </span>
          Select multiple slots
        </button>
        {multiSelect ? (
          <p className="text-[11px] text-fg-subtle">
            Tap green slots in one row, then book them together.
          </p>
        ) : null}
      </div>

      {confirmation ? (
        <div
          role="status"
          className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success"
        >
          {confirmation}
        </div>
      ) : null}

      {/* Grid. */}
      <div className="overflow-x-auto rounded-xl border border-line shadow-[var(--shadow-sm)]">
        <div className="grid bg-surface min-w-fit" style={gridStyle}>
          {/* Header corner cell. */}
          <div
            className="sticky left-0 z-20 border-b border-r border-line bg-surface"
            style={{ gridRow: 1, gridColumn: 1 }}
          />

          {/* Time-slot headers — hour labels on the even slots. */}
          {Array.from({ length: SCHEDULE_GRID_SLOTS }).map((_, slotIdx) => {
            const isHour = slotIdx % 2 === 0;
            const hour24 = SCHEDULE_GRID_FIRST_HOUR + Math.floor(slotIdx / 2);
            return (
              <div
                key={`h-${slotIdx}`}
                className={[
                  "border-b border-line text-[10px] uppercase tracking-wider text-fg-muted",
                  "flex items-end pb-1.5 pl-1",
                  isHour ? "border-l border-line-strong" : "border-l border-line/40",
                ].join(" ")}
                style={{ gridRow: 1, gridColumn: slotIdx + 2 }}
              >
                {isHour ? formatGridHour(hour24) : ""}
              </div>
            );
          })}

          {/* Resource label cells. */}
          {resources.map((r, i) => (
            <div
              key={`label-${r.id}`}
              className="sticky left-0 z-10 border-r border-line bg-surface flex items-center gap-2.5 pl-2 pr-3 py-2 text-sm font-medium text-fg"
              style={{ gridRow: i + 2, gridColumn: 1 }}
            >
              <span
                aria-hidden
                className={`h-6 w-0.5 rounded-full ${typeStripe(r.type)}`}
              />
              <span className="truncate">{r.name}</span>
            </div>
          ))}

          {/* Slot cells. */}
          {resources.map((r, i) =>
            Array.from({ length: SCHEDULE_GRID_SLOTS }).map((_, slotIdx) => {
              const { state, occupant } = slotStateFor(r.id, slotIdx);
              const isRevealed =
                revealed?.resourceId === r.id && revealed.slotIndex === slotIdx;
              const isSelected =
                selected?.resourceId === r.id && selected.slotIndex === slotIdx;
              const isBatchSelected =
                multiSelect &&
                selection.resourceId === r.id &&
                selection.slotIndexes.has(slotIdx);
              const { hour, minute } = slotHourMinute(slotIdx);
              return (
                <SlotCell
                  key={`cell-${r.id}-${slotIdx}`}
                  row={i + 2}
                  slotIdx={slotIdx}
                  state={state}
                  occupant={occupant}
                  isRevealed={isRevealed}
                  isSelected={isSelected}
                  isBatchSelected={isBatchSelected}
                  resourceName={r.name}
                  ownName={coachName}
                  hour={hour}
                  minute={minute}
                  onClick={() => handleSlotClick(r.id, slotIdx, state)}
                />
              );
            }),
          )}
        </div>
      </div>

      {/* Legend + hint. */}
      <div className="space-y-2 text-[11px] text-fg-muted">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <LegendDot className="bg-success/30 border border-success/50" label="Available" />
          <LegendDot className="bg-danger/20 border border-danger/50" label="Taken / blocked" />
          <LegendDot className="bg-gold/25 border border-gold/60" label="Your booking" />
        </div>
        <p className="text-fg-subtle">
          {multiSelect
            ? "Tap green slots in a single row to select them, then book the batch. Tapping a slot in a different row starts a new selection."
            : "Tap a green slot to book it. Tap a red slot to see who has it."}{" "}
          Rotate your phone or scroll sideways to see the full day.
        </p>
      </div>

      {/* Selection action bar — visible whenever ≥1 slot is selected. */}
      {multiSelect && selectionCount > 0 && selectionResource ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gold/40 bg-gold/5 px-4 py-3">
          <p className="text-sm font-medium text-fg">
            {selectionCount} {selectionCount === 1 ? "slot" : "slots"} ·{" "}
            <span className="text-fg-muted">{selectionResource.name}</span>
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={clearSelection}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 h-9 text-xs font-medium text-fg-muted hover:text-fg hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
            >
              <X className="h-3.5 w-3.5" />
              Clear
            </button>
            <button
              type="button"
              onClick={() => setBatchOpen(true)}
              className="rounded-lg bg-gold text-gold-ink hover:bg-gold-hover shadow-[var(--shadow-sm)] h-9 px-4 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
            >
              Book {selectionCount} {selectionCount === 1 ? "slot" : "slots"}
            </button>
          </div>
        </div>
      ) : null}

      {/* Booking panel for the selected green slot (single-slot path). */}
      {!multiSelect && selected && selectedResource ? (
        <CageSlotBooking
          resource={selectedResource}
          selectedDate={selectedDate}
          slotIndex={selected.slotIndex}
          canBookOneHour={selectedCanBookHour}
          onBooked={handleBooked}
          onCancel={() => setSelected(null)}
        />
      ) : null}

      {/* Batch booking form — one shared form for the whole selection. */}
      {multiSelect && batchOpen && selectionResource && selectionCount > 0 ? (
        <CageBatchBooking
          resource={selectionResource}
          selectedDate={selectedDate}
          slotIndexes={selection.slotIndexes}
          onBooked={handleBatchBooked}
          onCancel={() => setBatchOpen(false)}
        />
      ) : null}

    </div>
  );
}

function SlotCell({
  row,
  slotIdx,
  state,
  occupant,
  isRevealed,
  isSelected,
  isBatchSelected,
  resourceName,
  ownName,
  hour,
  minute,
  onClick,
}: {
  row: number;
  slotIdx: number;
  state: SlotState;
  occupant: SlotOccupant;
  isRevealed: boolean;
  isSelected: boolean;
  /** True when this slot is part of the batch multi-selection. */
  isBatchSelected: boolean;
  resourceName: string;
  /** The current coach's display name — shown on their own slots. */
  ownName: string;
  hour: number;
  minute: number;
  onClick: () => void;
}) {
  const baseBorders =
    slotIdx % 2 === 0
      ? "border-l border-line-strong"
      : "border-l border-line/40";

  const time12 = (() => {
    const h12 = hour % 12 === 0 ? 12 : hour % 12;
    const ampm = hour < 12 ? "AM" : "PM";
    return `${h12}:${minute === 0 ? "00" : "30"} ${ampm}`;
  })();

  const tone =
    state === "free"
      ? "bg-success/25 hover:bg-success/40"
      : state === "own"
        ? "bg-gold/25 hover:bg-gold/35"
        : "bg-danger/20 hover:bg-danger/30"; // taken or blocked

  const ariaLabel = (() => {
    if (state === "free")
      return isBatchSelected
        ? `Selected — ${resourceName} at ${time12}. Tap to deselect.`
        : `Book ${resourceName} at ${time12}`;
    if (state === "own") return `Your booking on ${resourceName} at ${time12}`;
    if (occupant?.kind === "session")
      return `${resourceName} at ${time12} — taken`;
    return `${resourceName} at ${time12} — blocked`;
  })();

  // For the coach's OWN slot, reveal a friendly "Your booking" line with
  // their name + the slot time (read-only — no other detail). For a
  // foreign session, reveal ONLY the booking coach's first name. For a
  // block, reveal ONLY the reason.
  const occupantLabel =
    state === "own"
      ? `Your booking — ${ownName}, ${time12}`
      : occupant?.kind === "session"
        ? occupant.coachFirstName
        : occupant?.kind === "block"
          ? occupant.reason
          : null;

  return (
    <div className="relative" style={{ gridRow: row, gridColumn: slotIdx + 2 }}>
      <button
        type="button"
        onClick={onClick}
        aria-label={ariaLabel}
        aria-pressed={isBatchSelected || undefined}
        className={[
          "relative h-full w-full border-b border-line text-left transition-colors",
          baseBorders,
          isBatchSelected ? "bg-gold/35 hover:bg-gold/45" : tone,
          isSelected || isBatchSelected ? "ring-2 ring-inset ring-gold" : "",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold/60",
        ].join(" ")}
      >
        {isBatchSelected ? (
          <Check
            aria-hidden
            className="absolute left-1/2 top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 text-gold-strong"
          />
        ) : null}
      </button>
      {isRevealed && occupantLabel ? (
        <span
          role="status"
          className="absolute left-1/2 top-full z-30 mt-1 -translate-x-1/2 whitespace-nowrap rounded-md border border-line-strong bg-surface px-2 py-1 text-[11px] font-medium text-fg shadow-[var(--shadow-md)]"
        >
          {state === "blocked" ? "Blocked: " : ""}
          {occupantLabel}
        </span>
      ) : null}
    </div>
  );
}

function LegendDot({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className={`inline-block h-3 w-5 rounded ${className}`} />
      {label}
    </span>
  );
}
