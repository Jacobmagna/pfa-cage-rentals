"use client";

// Batch booking panel for the W3.5b "Select multiple slots" flow on the
// CageCalendar. The coach taps several green slots on ONE resource row,
// then this panel collects ONE shared use type, ONE optional note, and the
// shared prepaid-online / PFA-referred flags. Submitting turns each
// selected 30-min slot into a SEPARATE session via the single batch action
// logOwnSessionsBatch (one resourceId + one useType, many time ranges) —
// so the whole selection is one atomic batch insert, never multiple calls.
//
// Single-resource constraint: the parent guarantees every selected slot
// belongs to the same `resource` (a cross-resource tap resets the
// selection upstream), so we never split a submit across resources — that
// would risk partial failure under neon-http's no-transaction model.
//
// The cage use-type guard (cageUseTypeError) runs client-side before
// submit; the server enforces it too. Typed server errors (overlap /
// blocked / use-type / a race) are translated to friendly inline copy,
// mirroring cage-slot-booking.tsx / form-actions.ts.

import { useState, useTransition } from "react";
import { ArrowDownToLine, Wifi, X } from "lucide-react";
import type { ResourceOption } from "../../_components/types";
import { logOwnSessionsBatch } from "../../actions";
import {
  BlockedTimeError,
  ResourceNotFoundError,
  SessionOverlapError,
  UseTypeValidationError,
} from "@/lib/errors";
import { cageUseTypeError } from "@/lib/use-type-validation";
import { selectionToSortedRanges } from "@/lib/coach-calendar";
import { SCHEDULE_GRID_FIRST_HOUR } from "@/lib/schedule-grid-utils";
import { formatPfaTime12h, pfaWallClockAt } from "@/lib/timezone";

// Friendly translation of the typed batch errors — same intent as
// form-actions.ts `translate`, inlined for this panel.
function translateError(err: unknown): string {
  if (
    err instanceof SessionOverlapError ||
    err instanceof BlockedTimeError ||
    err instanceof UseTypeValidationError ||
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
  const [useType, setUseType] = useState("");
  const [note, setNote] = useState("");
  const [flags, setFlags] = useState({ pfaReferred: false, isOnline: false });
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
    const normalizedUseType =
      useType === "hitting" || useType === "pitching" ? useType : null;
    const guard = cageUseTypeError(resource.type, normalizedUseType);
    if (guard) {
      setError(guard);
      return;
    }
    if (count === 0) return;
    const trimmedNote = note.trim() || null;
    startTransition(async () => {
      try {
        await logOwnSessionsBatch({
          resourceId: resource.id,
          useType: normalizedUseType,
          slots: sessions.map((s) => ({
            startAt: s.startAt,
            endAt: s.endAt,
            note: trimmedNote,
            isTeamRental: false,
            pfaReferred: flags.pfaReferred,
            isOnline: flags.isOnline,
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
            {count} {count === 1 ? "session" : "sessions"} of 30 min
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

      {/* One shared use type for all selected slots. */}
      <label className="block">
        <span className="block text-xs uppercase tracking-wider text-fg-muted mb-1.5">
          Use type
        </span>
        <select
          value={useType}
          onChange={(e) => setUseType(e.target.value)}
          className="w-full rounded-lg bg-surface border border-line text-fg px-3 h-12 text-base focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40 appearance-none"
        >
          <option value="">— None (bullpen / weight room)</option>
          <option value="hitting">Hitting</option>
          <option value="pitching">Pitching</option>
        </select>
        <span className="block text-[11px] text-fg-subtle mt-1 leading-snug">
          Applies to all {count} {count === 1 ? "slot" : "slots"}. Required for
          cages (hitting or pitching). Leave blank for bullpens and weight
          rooms.
        </span>
      </label>

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

      {/* Shared flags — no team rental on coach surfaces. */}
      <div className="flex flex-wrap gap-2">
        <FlagPill
          checked={flags.isOnline}
          onChange={(v) => setFlags((f) => ({ ...f, isOnline: v }))}
          label="Prepaid online lesson"
          icon={<Wifi className="h-3.5 w-3.5" />}
        />
        <FlagPill
          checked={flags.pfaReferred}
          onChange={(v) => setFlags((f) => ({ ...f, pfaReferred: v }))}
          label="PFA-referred"
          icon={<ArrowDownToLine className="h-3.5 w-3.5" />}
        />
      </div>

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

// Controlled flag pill — same visual language as cage-slot-booking.tsx.
function FlagPill({
  checked,
  onChange,
  label,
  icon,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      aria-pressed={checked}
      className={`inline-flex items-center gap-1.5 cursor-pointer select-none rounded-full border px-3 h-8 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 ${
        checked
          ? "border-gold/40 bg-gold/10 text-gold-strong"
          : "border-line bg-surface text-fg-muted hover:border-line-strong hover:text-fg"
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
