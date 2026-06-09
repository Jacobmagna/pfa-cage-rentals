"use client";

// Batch booking panel for the W3.5b "Select multiple slots" flow on the
// CageCalendar. The coach taps several green slots on ONE resource row,
// then this panel collects ONE optional note. Submitting turns each
// selected 30-min slot into a SEPARATE session via the single batch action
// logOwnSessionsBatch (one resourceId, many time ranges) — so the whole
// selection is one atomic batch insert, never multiple calls.
//
// Single-resource constraint: the parent guarantees every selected slot
// belongs to the same `resource` (a cross-resource tap resets the
// selection upstream), so we never split a submit across resources — that
// would risk partial failure under neon-http's no-transaction model.
//
// Typed server errors (overlap / blocked / a race) are translated to
// friendly inline copy, mirroring cage-slot-booking.tsx / form-actions.ts.

import { useState, useTransition } from "react";
import { X } from "lucide-react";
import type { ResourceOption } from "../../_components/types";
import { logOwnSessionsBatch } from "../../actions";
import {
  BlockedTimeError,
  ResourceNotFoundError,
  SessionOverlapError,
} from "@/lib/errors";
import { selectionToSortedRanges } from "@/lib/coach-calendar";
import { SCHEDULE_GRID_FIRST_HOUR } from "@/lib/schedule-grid-utils";
import { formatPfaTime12h, pfaWallClockAt } from "@/lib/timezone";

// Friendly translation of the typed batch errors — same intent as
// form-actions.ts `translate`, inlined for this panel.
function translateError(err: unknown): string {
  if (
    err instanceof SessionOverlapError ||
    err instanceof BlockedTimeError ||
    err instanceof ResourceNotFoundError
  ) {
    return err.message;
  }
  return "Couldn't book those slots. Try again or adjust your selection.";
}

export function CageBatchBooking({
  resource,
  selectedDate,
  slotIndexes,
  onBooked,
  onCancel,
}: {
  resource: ResourceOption;
  selectedDate: Date;
  /** Selected slot indices on `resource` (any order — sorted here). */
  slotIndexes: Set<number>;
  /** Called after a successful batch log so the parent re-fetches + confirms. */
  onBooked: (count: number) => void;
  onCancel: () => void;
}) {
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Deterministic, time-sorted list of the selected slots (each = 30 min).
  const ranges = selectionToSortedRanges(slotIndexes, SCHEDULE_GRID_FIRST_HOUR);
  const count = ranges.length;

  // Resolve each slot to its concrete [startAt, endAt) for display + submit.
  const sessions = ranges.map((r) => {
    const startAt = pfaWallClockAt(selectedDate, r.hour, r.minute);
    const endAt = new Date(startAt.getTime() + 30 * 60_000);
    return { startAt, endAt };
  });

  const handleSubmit = () => {
    setError(null);
    if (count === 0) return;
    const trimmedNote = note.trim() || null;
    startTransition(async () => {
      try {
        await logOwnSessionsBatch({
          resourceId: resource.id,
          slots: sessions.map((s) => ({
            startAt: s.startAt,
            endAt: s.endAt,
            note: trimmedNote,
          })),
        });
        onBooked(count);
      } catch (err) {
        // A race (someone booked one of these first) surfaces as
        // overlap/blocked; the parent re-fetches on the error path.
        setError(translateError(err));
      }
    });
  };

  return (
    <div className="rounded-xl border border-line bg-surface shadow-[var(--shadow-md)] p-4 sm:p-5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-0.5">
          <p className="text-xs uppercase tracking-wider text-fg-muted">
            Book {count} {count === 1 ? "slot" : "slots"}
          </p>
          <p className="text-sm font-semibold text-fg">{resource.name}</p>
          <p className="text-sm text-fg-muted">
            {sessions.map((s) => formatPfaTime12h(s.startAt)).join(", ")} —{" "}
            {count} {count === 1 ? "rental" : "rentals"} of 30 min
          </p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Cancel batch booking"
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-fg-subtle hover:text-fg hover:bg-surface-2/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          {error}
        </div>
      ) : null}

      {/* One shared note. */}
      <label className="block">
        <span className="flex items-baseline justify-between mb-1.5">
          <span className="text-xs uppercase tracking-wider text-fg-muted">
            Note
          </span>
          <span className="text-[10px] text-fg-subtle">optional</span>
        </span>
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={500}
          placeholder="Applies to every selected slot"
          className="w-full rounded-lg bg-surface border border-line text-fg placeholder:text-fg-subtle px-3 h-12 text-base focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40"
        />
      </label>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={pending || count === 0}
          className="rounded-lg bg-gold text-gold-ink hover:bg-gold-hover shadow-[var(--shadow-sm)] h-12 px-6 text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
        >
          {pending
            ? "Logging…"
            : `Book ${count} ${count === 1 ? "slot" : "slots"}`}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="text-sm text-fg-muted hover:text-fg transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
