"use client";

// Slim booking panel for a single green slot picked in the CageCalendar.
// Date/time/resource are INFERRED from the slot — the coach only chooses
// duration (30 min default; 1 hr offered only when the next slot is also
// free), use type, an optional note, and the prepaid-online / PFA-referred
// flags. Submitting logs ONE session via the existing logOwnSession.
//
// The use-type guard (cageUseTypeError) runs client-side before submit so
// a cage without a use type shows the friendly message inline; the server
// also enforces it. Typed server errors (overlap / blocked / use-type) are
// translated to friendly inline copy, mirroring form-actions.ts.

import { useState, useTransition } from "react";
import { ArrowDownToLine, Wifi, X } from "lucide-react";
import type { ResourceOption } from "../../_components/types";
import { logOwnSession } from "../../actions";
import {
  BlockedTimeError,
  ResourceNotFoundError,
  SessionOverlapError,
  UseTypeValidationError,
} from "@/lib/errors";
import { cageUseTypeError } from "@/lib/use-type-validation";
import { SCHEDULE_GRID_FIRST_HOUR } from "@/lib/schedule-grid-utils";
import { formatPfaTime12h, pfaWallClockAt } from "@/lib/timezone";

// Friendly translation of the typed server errors — same intent as
// form-actions.ts `translate`, inlined for the slot panel.
function translateError(err: unknown): string {
  if (
    err instanceof SessionOverlapError ||
    err instanceof BlockedTimeError ||
    err instanceof UseTypeValidationError ||
    err instanceof ResourceNotFoundError
  ) {
    return err.message;
  }
  return "Couldn't log that session. Try again or pick a different slot.";
}

function slotHourMinute(slotIndex: number): { hour: number; minute: number } {
  return {
    hour: SCHEDULE_GRID_FIRST_HOUR + Math.floor(slotIndex / 2),
    minute: (slotIndex % 2) * 30,
  };
}

export function CageSlotBooking({
  resource,
  selectedDate,
  slotIndex,
  canBookOneHour,
  onBooked,
  onCancel,
}: {
  resource: ResourceOption;
  selectedDate: Date;
  slotIndex: number;
  /** True when a 1-hr booking is allowed (this slot + next both free). */
  canBookOneHour: boolean;
  /** Called after a successful log so the parent can re-fetch + confirm. */
  onBooked: () => void;
  onCancel: () => void;
}) {
  const { hour, minute } = slotHourMinute(slotIndex);
  const startAt = pfaWallClockAt(selectedDate, hour, minute);

  const [durationMin, setDurationMin] = useState<30 | 60>(30);
  const [useType, setUseType] = useState("");
  const [note, setNote] = useState("");
  const [flags, setFlags] = useState({ pfaReferred: false, isOnline: false });
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // If a 1-hr slot was selected and the coach then can't book an hour
  // (e.g. a refresh revealed the next slot got taken), snap back to 30.
  // Derived-from-prop adjustment during render — the repo's lint-safe
  // pattern (no setState-in-effect).
  const [prevCanHour, setPrevCanHour] = useState(canBookOneHour);
  if (canBookOneHour !== prevCanHour) {
    setPrevCanHour(canBookOneHour);
    if (!canBookOneHour && durationMin === 60) setDurationMin(30);
  }

  const effectiveDuration = canBookOneHour ? durationMin : 30;
  const endAt = new Date(startAt.getTime() + effectiveDuration * 60_000);

  const handleSubmit = () => {
    setError(null);
    const guard = cageUseTypeError(
      resource.type,
      useType === "hitting" || useType === "pitching" ? useType : null,
    );
    if (guard) {
      setError(guard);
      return;
    }
    startTransition(async () => {
      try {
        await logOwnSession({
          resourceId: resource.id,
          startAt,
          endAt,
          useType:
            useType === "hitting" || useType === "pitching" ? useType : null,
          note: note.trim() || null,
          isTeamRental: false,
          pfaReferred: flags.pfaReferred,
          isOnline: flags.isOnline,
        });
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

      {/* Duration toggle. 1-hr only when the next slot is free. */}
      <div className="space-y-1.5">
        <span className="block text-xs uppercase tracking-wider text-fg-muted">
          Duration
        </span>
        <div className="inline-flex rounded-lg border border-line bg-surface p-0.5">
          <DurationButton
            active={effectiveDuration === 30}
            onClick={() => setDurationMin(30)}
            label="30 min"
          />
          {canBookOneHour ? (
            <DurationButton
              active={effectiveDuration === 60}
              onClick={() => setDurationMin(60)}
              label="1 hr"
            />
          ) : null}
        </div>
        {!canBookOneHour ? (
          <p className="text-[11px] text-fg-subtle">
            Next slot is busy — 30 min only.
          </p>
        ) : null}
      </div>

      {/* Use type. */}
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
          Required for cages (hitting or pitching). Leave blank for bullpens and
          weight rooms.
        </span>
      </label>

      {/* Note. */}
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

      {/* Flags — controlled pills mirroring the coach form's
          SessionFlagsRow visual (no team rental on coach surfaces). The
          panel owns the values so logOwnSession can read them directly. */}
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
          disabled={pending}
          className="rounded-lg bg-gold text-gold-ink hover:bg-gold-hover shadow-[var(--shadow-sm)] h-12 px-6 text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
        >
          {pending ? "Logging…" : "Book this slot"}
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

// Controlled flag pill — same visual language as the coach form's
// SessionFlagsRow, but the booking panel owns the value so it can pass it
// straight into logOwnSession (no form / FormData round-trip here).
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
