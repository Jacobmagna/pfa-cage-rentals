"use client";

// Batch booking panel for the W3.5b "Select multiple slots" flow on the
// CageCalendar. The coach taps several green slots — now across ANY
// resources (cages, bullpens, weight rooms) — then this panel collects
// ONE optional note. Submitting turns each selected 30-min slot into a
// SEPARATE session via the single batch action logOwnSessionsBatch (each
// slot carries its OWN resourceId, many time ranges) — so the whole
// selection is one atomic batch insert, never multiple calls.
//
// Multi-resource: every selected slot carries its own resourceId, so the
// batch can span several cages/resources. The rate is billed per resource
// type by the action; we never split a submit across multiple calls — one
// atomic insert keeps neon-http's no-transaction model safe from partial
// failure.
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
import {
  SCHEDULE_GRID_FIRST_HOUR,
  expandSlotKeys,
} from "@/lib/schedule-grid-utils";
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
  resources,
  selectedDate,
  selection,
  onBooked,
  onCancel,
}: {
  /** Full resource list — used to resolve each slot's resource name. */
  resources: ResourceOption[];
  selectedDate: Date;
  /** Selected slot keys `${resourceId}|${slotIndex}` (any order). */
  selection: Set<string>;
  /** Called after a successful batch log so the parent re-fetches + confirms. */
  onBooked: (count: number) => void;
  onCancel: () => void;
}) {
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Deterministic, (resourceId, slotIndex)-sorted list of selected slots
  // (each = 30 min), resolved to concrete [startAt, endAt) for display +
  // submit.
  const expanded = expandSlotKeys(selection, SCHEDULE_GRID_FIRST_HOUR);
  const rows = expanded.map((r) => {
    const startAt = pfaWallClockAt(selectedDate, r.hour, r.minute);
    const endAt = new Date(startAt.getTime() + 30 * 60_000);
    return { resourceId: r.resourceId, startAt, endAt };
  });
  const count = rows.length;

  // Group rows by resource for the grouped display — each group keeps its
  // resolved start times in sorted order (expandSlotKeys already sorted).
  const groups: Array<{ resourceId: string; starts: Date[] }> = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (last && last.resourceId === row.resourceId) {
      last.starts.push(row.startAt);
    } else {
      groups.push({ resourceId: row.resourceId, starts: [row.startAt] });
    }
  }
  const cageCount = groups.length;

  const resourceName = (id: string) =>
    resources.find((r) => r.id === id)?.name ?? "Unknown";

  const handleSubmit = () => {
    setError(null);
    if (count === 0) return;
    const trimmedNote = note.trim() || null;
    startTransition(async () => {
      try {
        await logOwnSessionsBatch({
          slots: rows.map((r) => ({
            resourceId: r.resourceId,
            startAt: r.startAt,
            endAt: r.endAt,
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
          {cageCount > 1 ? (
            <p className="text-sm text-fg-muted">
              across {cageCount} cages
            </p>
          ) : null}
          {/* Grouped by cage — name + its slot times. */}
          <div className="space-y-1 pt-1">
            {groups.map((g) => (
              <div key={g.resourceId} className="space-y-0.5">
                <p className="text-sm font-semibold text-fg">
                  {resourceName(g.resourceId)}
                </p>
                <p className="text-sm text-fg-muted">
                  {g.starts.map((s) => formatPfaTime12h(s)).join(", ")} —{" "}
                  {g.starts.length}{" "}
                  {g.starts.length === 1 ? "rental" : "rentals"} of 30 min
                </p>
              </div>
            ))}
          </div>
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
