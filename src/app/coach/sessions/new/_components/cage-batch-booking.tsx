"use client";

// Batch booking panel for the "Select multiple slots" flow on the
// CageCalendar. The coach taps several green slots — across ANY resources
// (cages, bullpens, weight rooms) AND ANY days (the selection persists as they
// navigate day to day) — then this panel collects ONE optional note.
// Submitting turns each selected 30-min slot into a SEPARATE session via the
// single batch action logOwnSessionsBatch (each slot carries its OWN
// resourceId + its own day's time range) — so the whole selection is one
// atomic batch insert, never multiple calls.
//
// Multi-resource: every selected slot carries its own resourceId, so the
// batch can span several cages/resources. The rate is billed per resource
// type by the action; we never split a submit across multiple calls — one
// atomic insert keeps neon-http's no-transaction model safe from partial
// failure.
//
// Typed server errors (overlap / blocked / a race) are translated to
// friendly inline copy, mirroring cage-slot-booking.tsx / form-actions.ts.
//
// WEIGHT ROOM (one hour minimum): back-to-back picks on the same weight
// room save as ONE rental (the server joins them), so the review list, the
// Book button and the confirmation count rentals SAVED, not taps. A weight
// room pick that does not make an hour is refused HERE, before anything is
// sent, with a line naming it: a production build strips the message from
// a thrown server error, so the catch below can only show its generic
// fallback. The server guard is the backstop.
//
// No booking is a group session any more: no checkbox, flag not sent.

import { useState, useTransition } from "react";
import { X } from "lucide-react";
import type { ResourceOption } from "../../_components/types";
import { logOwnSessionsBatch } from "../../actions";
import type { SlotState } from "@/lib/coach-calendar";
import {
  BlockedTimeError,
  ResourceNotFoundError,
  SessionOverlapError,
} from "@/lib/errors";
import {
  SCHEDULE_GRID_FIRST_HOUR,
  expandSlotKeys,
} from "@/lib/schedule-grid-utils";
import {
  formatPfaDateMedium,
  formatPfaTime12h,
  pfaWallClockToUtc,
} from "@/lib/timezone";
import {
  batchWeightRoomRefusal,
  countSavedRentals,
  weightRoomRentalLines,
} from "./weight-room-booking.logic";

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
  selection,
  displayedDate,
  slotStateOnDisplayedDay,
  onBooked,
  onCancel,
}: {
  /** Full resource list — used to resolve each slot's resource name. */
  resources: ResourceOption[];
  /**
   * Selected slot keys `${date}|${resourceId}|${slotIndex}` (any order). The
   * leading PFA-local date means a selection can span MULTIPLE days — each slot
   * carries its own day, so no single "selected date" is needed here.
   */
  selection: Set<string>;
  /** The PFA-local day the calendar is showing, "YYYY-MM-DD". */
  displayedDate: string;
  /**
   * State of a slot on the DISPLAYED day only (the calendar has no other
   * day loaded). Used to suggest a fix for a lone weight room pick.
   */
  slotStateOnDisplayedDay: (resourceId: string, slotIndex: number) => SlotState;
  /**
   * Called after a successful batch log so the parent re-fetches + confirms.
   * `count` = rentals saved (rows the server returned), not slots tapped.
   */
  onBooked: (count: number) => void;
  onCancel: () => void;
}) {
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Deterministic, (date, resourceId, slotIndex)-sorted list of selected slots
  // (each = 30 min), resolved to concrete [startAt, endAt) for display +
  // submit. Each slot's startAt is built from ITS OWN day, so the batch can
  // span multiple days in one atomic insert.
  const expanded = expandSlotKeys(selection, SCHEDULE_GRID_FIRST_HOUR);
  const rows = expanded.map((r) => {
    const hh = String(r.hour).padStart(2, "0");
    const mm = r.minute === 0 ? "00" : "30";
    const startAt = pfaWallClockToUtc(r.date, `${hh}:${mm}`);
    const endAt = new Date(startAt.getTime() + 30 * 60_000);
    return {
      date: r.date,
      resourceId: r.resourceId,
      slotIndex: r.slotIndex,
      startAt,
      endAt,
    };
  });
  const count = rows.length;
  const dayCount = new Set(rows.map((r) => r.date)).size;
  const cageCount = new Set(rows.map((r) => r.resourceId)).size;

  // Group rows by DAY, then by resource within each day, for the review list
  // (rows are already sorted by date → resourceId → slotIndex).
  type CageGroup = { resourceId: string; starts: Date[] };
  type DayGroup = { date: string; label: string; cages: CageGroup[] };
  const days: DayGroup[] = [];
  for (const row of rows) {
    let day = days[days.length - 1];
    if (!day || day.date !== row.date) {
      day = { date: row.date, label: formatPfaDateMedium(row.startAt), cages: [] };
      days.push(day);
    }
    let cage = day.cages[day.cages.length - 1];
    if (!cage || cage.resourceId !== row.resourceId) {
      cage = { resourceId: row.resourceId, starts: [] };
      day.cages.push(cage);
    }
    cage.starts.push(row.startAt);
  }

  const resourceName = (id: string) =>
    resources.find((r) => r.id === id)?.name ?? "Unknown";

  const isWeightRoom = (id: string) =>
    resources.find((r) => r.id === id)?.type === "weight_room";

  // Does the current selection include at least one weight-room slot? Only
  // then is the one-hour hint shown.
  const selectionHasWeightRoom = rows.some((r) => isWeightRoom(r.resourceId));

  // Rentals that will be SAVED: back-to-back weight room picks join into
  // one; cages and bullpens stay one per slot.
  const savedCount = countSavedRentals(rows, isWeightRoom);

  // Weight room picks that do not make an hour. Any → refuse up front:
  // the lines are shown and the Book button is disabled, so nothing is sent.
  const refusalLines = batchWeightRoomRefusal({
    rows,
    isWeightRoom,
    resourceName,
    displayedDate,
    slotState: slotStateOnDisplayedDay,
  });
  const refused = refusalLines.length > 0;

  const handleSubmit = () => {
    setError(null);
    if (count === 0 || refused) return;
    const trimmedNote = note.trim() || null;
    startTransition(async () => {
      try {
        const saved = await logOwnSessionsBatch({
          slots: rows.map((r) => ({
            resourceId: r.resourceId,
            startAt: r.startAt,
            endAt: r.endAt,
            note: trimmedNote,
          })),
        });
        onBooked(saved.length);
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
          {/* Rentals that will be saved, the same count as the Book button
              (back-to-back weight room picks are one rental). */}
          <p className="text-xs uppercase tracking-wider text-fg-muted">
            Book {savedCount} {savedCount === 1 ? "rental" : "rentals"}
          </p>
          {dayCount > 1 || cageCount > 1 ? (
            <p className="text-sm text-fg-muted">
              across {dayCount} {dayCount === 1 ? "day" : "days"} ·{" "}
              {cageCount} {cageCount === 1 ? "cage" : "cages"}
            </p>
          ) : null}
          {/* Grouped by day, then cage — a date header, then each cage's name
              and its slot times under that day. */}
          <div className="space-y-2 pt-1">
            {days.map((d) => (
              <div key={d.date} className="space-y-1">
                <p className="text-xs font-semibold uppercase tracking-wider text-fg-muted">
                  {d.label}
                </p>
                {d.cages.map((g) => (
                  <div key={g.resourceId} className="space-y-0.5 pl-0.5">
                    <p className="text-sm font-semibold text-fg">
                      {resourceName(g.resourceId)}
                    </p>
                    {isWeightRoom(g.resourceId) ? (
                      // Weight room: each rental that will be saved, as a
                      // range with its length.
                      weightRoomRentalLines(
                        g.starts.map((s) => ({
                          startAt: s,
                          endAt: new Date(s.getTime() + 30 * 60_000),
                        })),
                      ).map((line) => (
                        <p key={line} className="text-sm text-fg-muted">
                          {line}
                        </p>
                      ))
                    ) : (
                      <p className="text-sm text-fg-muted">
                        {g.starts.map((s) => formatPfaTime12h(s)).join(", ")} —{" "}
                        {g.starts.length}{" "}
                        {g.starts.length === 1 ? "rental" : "rentals"} of 30 min
                      </p>
                    )}
                  </div>
                ))}
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

      {/* One-hour rule, said once whenever a weight room is picked. */}
      {selectionHasWeightRoom ? (
        <p className="text-[11px] text-fg-subtle">
          Weight room rentals are one hour minimum: pick back-to-back half
          hours on the same spot.
        </p>
      ) : null}

      {/* Lone weight room picks: refused before anything is sent. */}
      {refused ? (
        <div
          role="alert"
          className="space-y-1 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          {refusalLines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      ) : null}

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
          disabled={pending || count === 0 || refused}
          className="rounded-lg bg-gold text-gold-ink hover:bg-gold-hover shadow-[var(--shadow-sm)] h-12 px-6 text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
        >
          {pending
            ? "Logging…"
            : `Book ${savedCount} ${savedCount === 1 ? "rental" : "rentals"}`}
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
