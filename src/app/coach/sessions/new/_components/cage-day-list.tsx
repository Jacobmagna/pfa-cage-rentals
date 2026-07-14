"use client";

// Mobile-only vertical slot list for the coach cage-booking calendar.
//
// PRESENTATIONAL ONLY — props in, render out. No data fetching, no server
// imports. The parent (cage-calendar.tsx) owns all state (selected /
// selection / multiSelect) and builds the `slots` array for the
// currently-selected resource, then routes taps back through its existing
// `handleSlotClick`. Keeping this props-only lets it be previewed with mock
// data and keeps the parent the single source of truth. Busy rows show their
// occupant (coach first name / block reason) up-front — no tap-to-reveal.

import { Check, Plus } from "lucide-react";
import type { SlotState } from "@/lib/coach-calendar";

export type CageDaySlot = {
  slotIndex: number;
  /** 12-hour time range, e.g. "4:00 – 4:30 PM". */
  timeLabel: string;
  state: SlotState;
  /** First name (taken) / block reason (blocked) / null otherwise. Shown
      up-front on busy rows so the coach sees who/what holds the slot without
      tapping. */
  occupantLabel: string | null;
  isSelected: boolean;
  isBatchSelected: boolean;
};

export function CageDayList({
  slots,
  multiSelect: _multiSelect,
  onSlotClick,
}: {
  slots: CageDaySlot[];
  /** Kept in the public shape (mirrors the grid); per-row visuals are
      already driven by each slot's isBatchSelected flag. */
  multiSelect: boolean;
  onSlotClick: (slotIndex: number) => void;
}) {
  void _multiSelect;
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)]">
      {slots.map((slot) => (
        <li key={slot.slotIndex}>
          <CageDayRow slot={slot} onClick={() => onSlotClick(slot.slotIndex)} />
        </li>
      ))}
    </ul>
  );
}

function CageDayRow({
  slot,
  onClick,
}: {
  slot: CageDaySlot;
  onClick: () => void;
}) {
  const { timeLabel, state, occupantLabel, isSelected, isBatchSelected } =
    slot;

  const tone =
    isBatchSelected
      ? "bg-gold/35 hover:bg-gold/45"
      : state === "free"
        ? "bg-surface hover:bg-success/15"
        : state === "own"
          ? "bg-gold/20 hover:bg-gold/30"
          : "bg-danger/15 hover:bg-danger/25"; // taken or blocked

  const emphasized = isSelected || isBatchSelected;

  const ariaLabel = (() => {
    if (state === "free")
      return isBatchSelected
        ? `Selected — ${timeLabel}. Tap to deselect.`
        : `Book ${timeLabel}`;
    if (state === "own") return `Your booking at ${timeLabel}`;
    if (state === "blocked")
      return occupantLabel
        ? `${timeLabel} — blocked: ${occupantLabel}`
        : `${timeLabel} — blocked`;
    return occupantLabel
      ? `${timeLabel} — taken by ${occupantLabel}`
      : `${timeLabel} — taken`;
  })();

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      aria-pressed={isBatchSelected || undefined}
      className={[
        "flex min-h-[44px] w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors",
        tone,
        emphasized ? "ring-2 ring-inset ring-gold" : "",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold/60",
      ].join(" ")}
    >
      <span className="shrink-0 text-sm font-medium tabular-nums text-fg">
        {timeLabel}
      </span>

      <span className="flex min-w-0 items-center justify-end gap-2">
        {state === "free" ? (
          isBatchSelected ? (
            <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-semibold text-gold-strong">
              <Check aria-hidden className="h-4 w-4" />
              Selected
            </span>
          ) : (
            <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-fg-muted">
              <Plus aria-hidden className="h-4 w-4" />
              Book
            </span>
          )
        ) : state === "own" ? (
          <span className="shrink-0 text-xs font-semibold text-gold-strong">
            Your booking
          </span>
        ) : (
          // taken / blocked: show who/what holds the slot up-front (coach
          // first name, or the block reason like "Program: <name>") so it's
          // legible at a glance without tapping. Long program names wrap
          // rather than clip.
          <span className="min-w-0 break-words text-right text-xs font-medium text-fg-muted">
            {occupantLabel ?? (state === "blocked" ? "Blocked" : "Taken")}
          </span>
        )}
      </span>
    </button>
  );
}
