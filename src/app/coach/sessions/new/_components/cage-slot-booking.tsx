"use client";

// Slim booking panel for a single green slot picked in the CageCalendar.
// Date/time/resource are INFERRED from the slot — the coach chooses a
// duration (30 min default; 1 hr or a Custom length offered up to the run
// of consecutive free slots) and an optional note.
//
// Duration → submit routing (#7 + #20):
//   • The selected duration ALWAYS defaults to what the coach picked: one
//     30-min slot → one 30-min rental.
//   • duration === 30, or a custom length NOT a multiple of 30 → ONE rental
//     of the full duration via logOwnSession (single note).
//   • duration > 30 AND a multiple of 30 → a "Book as separate 30-minute
//     rentals" checkbox appears (default UNCHECKED):
//       - unchecked → ONE rental of the full duration (single note).
//       - checked  → split into N = duration/30 back-to-back 30-min
//         rentals, each with its OWN note, via logOwnSessionsBatch.
//
// The selectable/typed duration is clamped to [30, maxDurationMin], where
// maxDurationMin = (consecutive free slots from this one) * 30 — so the
// coach can never book past a busy slot or off the end of the day.
//
// Typed server errors (overlap / blocked) are translated to friendly inline
// copy, mirroring form-actions.ts.

import { useState, useTransition } from "react";
import { X } from "lucide-react";
import type { ResourceOption } from "../../_components/types";
import { logOwnSession, logOwnSessionsBatch } from "../../actions";
import {
  BlockedTimeError,
  ResourceNotFoundError,
  SessionOverlapError,
} from "@/lib/errors";
import { SCHEDULE_GRID_FIRST_HOUR } from "@/lib/schedule-grid-utils";
import { formatPfaTime12h, pfaWallClockAt } from "@/lib/timezone";
import {
  SessionSlotsList,
  deriveSlots,
  type SlotInput,
} from "@/app/_components/session-slots-list";

// Friendly translation of the typed server errors — same intent as
// form-actions.ts `translate`, inlined for the slot panel.
function translateError(err: unknown): string {
  if (
    err instanceof SessionOverlapError ||
    err instanceof BlockedTimeError ||
    err instanceof ResourceNotFoundError
  ) {
    return err.message;
  }
  return "Couldn't log that rental. Try again or pick a different slot.";
}

function slotHourMinute(slotIndex: number): { hour: number; minute: number } {
  return {
    hour: SCHEDULE_GRID_FIRST_HOUR + Math.floor(slotIndex / 2),
    minute: (slotIndex % 2) * 30,
  };
}

// Clamp a candidate duration (minutes) to [30, maxDurationMin], coercing
// to a positive whole number of minutes. maxDurationMin is itself a
// multiple of 30 (free-slot-count * 30), so the upper clamp keeps the
// rental inside the run of free slots.
function clampDuration(candidate: number, maxDurationMin: number): number {
  if (!Number.isFinite(candidate)) return 30;
  const whole = Math.round(candidate);
  if (whole < 30) return 30;
  if (whole > maxDurationMin) return maxDurationMin;
  return whole;
}

export function CageSlotBooking({
  resource,
  selectedDate,
  slotIndex,
  maxDurationMin,
  onBooked,
  onCancel,
}: {
  resource: ResourceOption;
  selectedDate: Date;
  slotIndex: number;
  /**
   * Max rental length in minutes = (# consecutive free 30-min slots from
   * this one) * 30. Always >= 30 when a free slot was tapped. Caps the
   * selectable/typed duration so a booking can't run into a busy slot.
   */
  maxDurationMin: number;
  /** Called after a successful log so the parent can re-fetch + confirm. */
  onBooked: () => void;
  onCancel: () => void;
}) {
  const { hour, minute } = slotHourMinute(slotIndex);
  const startAt = pfaWallClockAt(selectedDate, hour, minute);
  const startMs = startAt.getTime();

  // Which duration preset is active. "custom" reveals a free-minutes input.
  const [mode, setMode] = useState<"30" | "60" | "custom">("30");
  // The committed duration in minutes (always clamped to [30, maxDurationMin]).
  const [durationMin, setDurationMin] = useState(30);
  // Raw text of the custom-minutes input (validated/clamped on blur+submit).
  const [customText, setCustomText] = useState("30");

  // Single-note path (one rental).
  const [note, setNote] = useState("");
  // Split path: per-slot notes for the N 30-min rentals.
  const [splitChecked, setSplitChecked] = useState(false);
  const [splitSlots, setSplitSlots] = useState<SlotInput[]>([]);

  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Safety: if availability shrank (a refresh revealed the next slot got
  // taken so maxDurationMin dropped below the chosen duration), clamp the
  // selection back down. Derived-from-prop adjustment during render — the
  // repo's lint-safe pattern (no setState-in-effect).
  const [prevMax, setPrevMax] = useState(maxDurationMin);
  if (maxDurationMin !== prevMax) {
    setPrevMax(maxDurationMin);
    if (durationMin > maxDurationMin) {
      const clamped = clampDuration(durationMin, maxDurationMin);
      setDurationMin(clamped);
      setCustomText(String(clamped));
      // Snap presets back to a still-valid choice.
      if (mode === "60" && maxDurationMin < 60) setMode("30");
    }
  }

  const only30 = maxDurationMin <= 30;
  const canHour = maxDurationMin >= 60;

  const selectPreset = (next: 30 | 60) => {
    const d = clampDuration(next, maxDurationMin);
    setMode(next === 30 ? "30" : "60");
    setDurationMin(d);
    setCustomText(String(d));
    setSplitChecked(false);
  };

  const selectCustom = () => {
    setMode("custom");
    // Seed the custom field from the current duration so it starts valid.
    setCustomText(String(durationMin));
    setSplitChecked(false);
  };

  const commitCustom = (raw: string) => {
    const parsed = Number.parseInt(raw, 10);
    const d = clampDuration(Number.isNaN(parsed) ? 30 : parsed, maxDurationMin);
    setDurationMin(d);
    setCustomText(String(d));
    setSplitChecked(false);
  };

  // The split checkbox only makes sense for a whole number of 30-min
  // rentals longer than one slot.
  const canSplit = durationMin > 30 && durationMin % 30 === 0;
  const isSplitting = canSplit && splitChecked;
  const splitCount = isSplitting ? durationMin / 30 : 0;

  const endAt = new Date(startMs + durationMin * 60_000);

  // When splitting, derive the N back-to-back 30-min slot inputs, keeping
  // any notes the coach already typed (matched by start/end signature).
  const toggleSplit = (checked: boolean) => {
    setSplitChecked(checked);
    if (checked) {
      setSplitSlots((prev) =>
        deriveSlots(
          startAt,
          new Date(startMs + durationMin * 60_000),
          30,
          prev,
        ),
      );
    }
  };

  const handleSubmit = () => {
    setError(null);
    startTransition(async () => {
      try {
        if (isSplitting) {
          // Re-derive at submit time so the slots always match the current
          // start + duration, carrying typed notes forward.
          const slots = deriveSlots(
            startAt,
            new Date(startMs + durationMin * 60_000),
            30,
            splitSlots,
          );
          await logOwnSessionsBatch({
            resourceId: resource.id,
            slots: slots.map((s) => ({
              startAt: s.startAt,
              endAt: s.endAt,
              note: s.note.trim() || null,
            })),
          });
        } else {
          await logOwnSession({
            resourceId: resource.id,
            startAt,
            endAt,
            note: note.trim() || null,
          });
        }
        onBooked();
      } catch (err) {
        // A race (someone booked it first) surfaces as overlap/blocked.
        setError(translateError(err));
      }
    });
  };

  return (
    <div className="rounded-xl border border-line bg-surface shadow-[var(--shadow-md)] p-4 sm:p-5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-0.5">
          <p className="text-xs uppercase tracking-wider text-fg-muted">
            Book a slot
          </p>
          <p className="text-sm font-semibold text-fg">{resource.name}</p>
          <p className="text-sm text-fg-muted">
            {formatPfaTime12h(startAt)} – {formatPfaTime12h(endAt)}
          </p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Cancel booking"
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

      {/* Duration. 30 always; 1 hr / Custom up to the run of free slots. */}
      <div className="space-y-1.5">
        <span className="block text-xs uppercase tracking-wider text-fg-muted">
          Duration
        </span>
        <div
          role="group"
          aria-label="Rental duration"
          className="inline-flex rounded-lg border border-line bg-surface p-0.5"
        >
          <DurationButton
            active={mode === "30"}
            onClick={() => selectPreset(30)}
            label="30 min"
          />
          {canHour ? (
            <DurationButton
              active={mode === "60"}
              onClick={() => selectPreset(60)}
              label="1 hr"
            />
          ) : null}
          {!only30 ? (
            <DurationButton
              active={mode === "custom"}
              onClick={selectCustom}
              label="Custom"
            />
          ) : null}
        </div>

        {mode === "custom" && !only30 ? (
          <label className="flex items-center gap-2 pt-1">
            <span className="text-xs text-fg-muted">Minutes</span>
            <input
              type="number"
              inputMode="numeric"
              min={30}
              max={maxDurationMin}
              step={5}
              value={customText}
              aria-label="Custom rental length in minutes"
              onChange={(e) => setCustomText(e.target.value)}
              onBlur={(e) => commitCustom(e.target.value)}
              className="w-24 rounded-lg bg-surface border border-line text-fg placeholder:text-fg-subtle px-3 h-9 text-sm focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40"
            />
            <span className="text-[11px] text-fg-subtle">
              up to {maxDurationMin} min
            </span>
          </label>
        ) : null}

        {only30 ? (
          <p className="text-[11px] text-fg-subtle">
            Next slot is busy — 30 min only.
          </p>
        ) : null}
      </div>

      {/* Split-into-30s checkbox — only for a whole number of 30-min
          rentals longer than one slot. Default unchecked = one rental. */}
      {canSplit ? (
        <label className="flex items-start gap-2.5">
          <input
            type="checkbox"
            checked={splitChecked}
            onChange={(e) => toggleSplit(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-line-strong text-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
          />
          <span className="space-y-0.5">
            <span className="block text-sm font-medium text-fg">
              Book as separate 30-minute rentals
            </span>
            <span className="block text-[11px] text-fg-subtle">
              {durationMin} min becomes {durationMin / 30} back-to-back 30-min
              rentals, each with its own note.
            </span>
          </span>
        </label>
      ) : null}

      {/* Notes. Split → per-rental notes; otherwise one shared note. */}
      {isSplitting ? (
        <SessionSlotsList
          slots={splitSlots}
          onChange={setSplitSlots}
        />
      ) : (
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
            placeholder="Optional context"
            className="w-full rounded-lg bg-surface border border-line text-fg placeholder:text-fg-subtle px-3 h-12 text-base focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40"
          />
        </label>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={pending}
          className="rounded-lg bg-gold text-gold-ink hover:bg-gold-hover shadow-[var(--shadow-sm)] h-12 px-6 text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
        >
          {pending
            ? "Logging…"
            : isSplitting
              ? `Book ${splitCount} rentals`
              : "Book this slot"}
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

function DurationButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        "rounded-md px-3 h-9 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40",
        active
          ? "bg-gold/15 text-gold-strong"
          : "text-fg-muted hover:text-fg",
      ].join(" ")}
    >
      {label}
    </button>
  );
}
