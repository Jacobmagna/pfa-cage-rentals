"use client";

// Per-slot notecard list for the multi-slot session flow. Renders N
// cards, one per generated time range, each with its own optional
// note and team-rental checkbox. Coach (or admin) picks a date +
// start + end + slot length on the parent form; this component
// renders an editor over the `slots` array.
//
// State strategy: per-slot notes + team-rental flags live in the
// parent's state. The canonical slot derivation lives in `deriveSlots`
// (exported below).
//
// Two integration modes:
//   1. Self-deriving (legacy, admin forms): pass `rangeStart` /
//      `rangeEnd` / `slotLengthMinutes` and this component rebuilds the
//      slot array from them and emits via `onChange` (effect). The list
//      only renders cards once the parent's `slots` is non-empty.
//   2. Presentational-only (coach form): omit the range props. The
//      PARENT owns derivation (calling `deriveSlots` directly) so its
//      `slots[]` is always populated whether or not this editor is even
//      mounted — that keeps the multi-slot batch submit correct even
//      when the per-session notes UI is collapsed/hidden.
//
// Submission: this component doesn't submit itself. The parent owns
// the slot array and includes it in its own logOwnSessionsBatch /
// createSessionsBatch call.
//
// Note: derivation is kept under SAFE_SLOT_LIMIT (server enforces 50)
// to stop the UI from rendering hundreds of cards if a user pastes
// garbage into the date inputs.

import { useEffect, useMemo, useRef } from "react";
import { PFA_TIMEZONE } from "@/lib/timezone";

const SAFE_SLOT_LIMIT = 50;

export type SlotInput = {
  startAt: Date;
  endAt: Date;
  note: string;
  isTeamRental: boolean;
  pfaReferred: boolean;
  isOnline: boolean;
};

// Canonical slot derivation. Given the computed range + slot length,
// produce the N slot inputs. Each slot keeps its existing note/flags
// ONLY if its (startAt, endAt) signature is unchanged vs.
// `priorSlots` — so a range tweak that produces overlapping slot
// signatures keeps typed notes. Returns [] for any invalid range (no
// range, non-positive span, non-divisible span, or count outside
// 1..SAFE_SLOT_LIMIT).
//
// Pure + side-effect-free so it can live in a parent's render and be
// unit-tested directly.
export function deriveSlots(
  rangeStart: Date | null,
  rangeEnd: Date | null,
  slotLengthMinutes: 30 | 60,
  priorSlots: SlotInput[] = [],
): SlotInput[] {
  if (!rangeStart || !rangeEnd) return [];
  const lengthMs = slotLengthMinutes * 60_000;
  const totalMs = rangeEnd.getTime() - rangeStart.getTime();
  if (totalMs <= 0) return [];
  if (totalMs % lengthMs !== 0) return [];
  const count = totalMs / lengthMs;
  if (count <= 0 || count > SAFE_SLOT_LIMIT) return [];

  const priorByKey = new Map<
    string,
    {
      note: string;
      isTeamRental: boolean;
      pfaReferred: boolean;
      isOnline: boolean;
    }
  >();
  for (const s of priorSlots) {
    priorByKey.set(slotKey(s.startAt, s.endAt), {
      note: s.note,
      isTeamRental: s.isTeamRental,
      pfaReferred: s.pfaReferred,
      isOnline: s.isOnline,
    });
  }

  const out: SlotInput[] = [];
  for (let i = 0; i < count; i++) {
    const startAt = new Date(rangeStart.getTime() + i * lengthMs);
    const endAt = new Date(startAt.getTime() + lengthMs);
    const prior = priorByKey.get(slotKey(startAt, endAt));
    out.push({
      startAt,
      endAt,
      note: prior?.note ?? "",
      isTeamRental: prior?.isTeamRental ?? false,
      pfaReferred: prior?.pfaReferred ?? false,
      isOnline: prior?.isOnline ?? false,
    });
  }
  return out;
}

type Props = {
  /**
   * Computed UTC instant for the FIRST slot start. Pass (with rangeEnd
   * + slotLengthMinutes) to run the legacy self-deriving mode. Omit for
   * presentational-only mode where the parent owns derivation.
   */
  rangeStart?: Date | null;
  /** Computed UTC instant for the LAST slot end (exclusive). */
  rangeEnd?: Date | null;
  /** 30 or 60. */
  slotLengthMinutes?: 30 | 60;
  /** Current per-slot inputs. Parent owns the array. */
  slots: SlotInput[];
  /** Emit a new slots array when the user edits a note or toggle. */
  onChange: (slots: SlotInput[]) => void;
  /** Hide the "Team rental" toggle on coach surfaces. */
  showTeamRental?: boolean;
};

export function SessionSlotsList({
  rangeStart,
  rangeEnd,
  slotLengthMinutes,
  slots,
  onChange,
  showTeamRental = true,
}: Props) {
  // Legacy self-deriving mode: only active when the parent supplies the
  // range props. The coach form omits them (it owns derivation), so
  // this whole block is inert there.
  const selfDeriving =
    rangeStart !== undefined &&
    rangeEnd !== undefined &&
    slotLengthMinutes !== undefined;

  const computed = useMemo<SlotInput[]>(() => {
    if (!selfDeriving) return [];
    return deriveSlots(
      rangeStart ?? null,
      rangeEnd ?? null,
      slotLengthMinutes ?? 30,
      slots,
    );
  }, [selfDeriving, rangeStart, rangeEnd, slotLengthMinutes, slots]);

  // Propagate the rebuilt array upward. Effect (not direct setState)
  // because computed is derived from props; calling onChange during
  // render would loop.
  const lastEmittedRef = useRef<string>("");
  useEffect(() => {
    if (!selfDeriving) return;
    const sig = computed
      .map(
        (s) =>
          `${s.startAt.toISOString()}|${s.note}|${s.isTeamRental ? 1 : 0}|${s.pfaReferred ? 1 : 0}|${s.isOnline ? 1 : 0}`,
      )
      .join("·");
    const current = slots
      .map(
        (s) =>
          `${s.startAt.toISOString()}|${s.note}|${s.isTeamRental ? 1 : 0}|${s.pfaReferred ? 1 : 0}|${s.isOnline ? 1 : 0}`,
      )
      .join("·");
    if (sig !== current && sig !== lastEmittedRef.current) {
      lastEmittedRef.current = sig;
      onChange(computed);
    }
  }, [selfDeriving, computed, slots, onChange]);

  if (slots.length === 0) return null;

  const updateNote = (i: number, note: string) => {
    const next = slots.map((s, idx) => (idx === i ? { ...s, note } : s));
    onChange(next);
  };
  const updateTeam = (i: number, isTeamRental: boolean) => {
    const next = slots.map((s, idx) =>
      idx === i ? { ...s, isTeamRental } : s,
    );
    onChange(next);
  };
  const updatePfaReferred = (i: number, pfaReferred: boolean) => {
    const next = slots.map((s, idx) =>
      idx === i ? { ...s, pfaReferred } : s,
    );
    onChange(next);
  };
  const updateOnline = (i: number, isOnline: boolean) => {
    const next = slots.map((s, idx) => (idx === i ? { ...s, isOnline } : s));
    onChange(next);
  };

  return (
    <div className="space-y-2">
      <p className="text-xs uppercase tracking-wider text-fg-muted">
        {slots.length} {slots.length === 1 ? "session" : "sessions"} — optional
        per-session details
      </p>
      <ul className="space-y-2">
        {slots.map((slot, i) => (
          <li
            key={slot.startAt.toISOString()}
            className="rounded-md border border-line bg-surface shadow-[var(--shadow-sm)] p-3 transition hover:border-line-strong hover:shadow-[var(--shadow-md)]"
          >
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <p className="text-sm font-mono tabular-nums text-fg">
                {formatRangeShort(slot.startAt, slot.endAt)}
              </p>
              <div className="flex items-center gap-1.5 flex-wrap">
                {showTeamRental ? (
                  <SlotPill
                    checked={slot.isTeamRental}
                    onChange={(v) => updateTeam(i, v)}
                    label="Team"
                  />
                ) : null}
                <SlotPill
                  checked={slot.isOnline}
                  onChange={(v) => updateOnline(i, v)}
                  label="Online"
                />
                <SlotPill
                  checked={slot.pfaReferred}
                  onChange={(v) => updatePfaReferred(i, v)}
                  label="PFA"
                />
              </div>
            </div>
            <input
              type="text"
              value={slot.note}
              onChange={(e) => updateNote(i, e.target.value)}
              maxLength={500}
              placeholder="Optional note (student, drill, etc.)"
              className="mt-2 w-full rounded-lg bg-surface-2 border border-line text-fg placeholder:text-fg-subtle px-2.5 h-8 text-xs focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40"
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function slotKey(start: Date, end: Date): string {
  return `${start.toISOString()}|${end.toISOString()}`;
}

function SlotPill({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label
      className={`inline-flex items-center gap-1 cursor-pointer select-none rounded-full border px-2.5 h-6 text-[11px] font-medium transition-colors ${
        checked
          ? "border-gold/40 bg-gold/10 text-gold-strong"
          : "border-line bg-surface text-fg-muted hover:border-line-strong hover:text-fg"
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="sr-only"
      />
      <span>{label}</span>
    </label>
  );
}

// Compact label like "10:00 AM – 10:30 AM" (date is implied by the
// outer form's date input — no point repeating it 8 times).
function formatRangeShort(start: Date, end: Date): string {
  const opts: Intl.DateTimeFormatOptions = {
    timeZone: PFA_TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
  };
  return `${start.toLocaleTimeString("en-US", opts)} – ${end.toLocaleTimeString("en-US", opts)}`;
}
