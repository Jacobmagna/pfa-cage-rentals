"use client";

import { useState, useTransition } from "react";
import { CalendarClock, Check, ChevronDown, UserPlus, X } from "lucide-react";
import { cancelOwnBlock, logOwnHour, reassignOwnBlock } from "../actions";

// QA10 W3.7 — "Confirm your scheduled hours". One card per scheduled
// program block whose end is within 15 min of now (the server filters
// to those via isBlockConfirmable + drops blocks already logged). Each
// card has a one-click "Confirm these hours" button that calls the
// existing logOwnHour action with the block's exact program + start/end.
//
// W3-handoff: each card also offers two secondary actions for a shift the
// coach DIDN'T work — "Gave it to another coach" (reassigns the block to a
// chosen coach) and "Didn't work it" (marks it not-worked / no cover, which
// surfaces in the admin needs-review queue). Both remove the card on success.
//
// On success the card is removed from the LOCAL list (a pure render-time
// filter over resolvedIds kept in component state — no setState-in-effect)
// and the page revalidates so a refresh shows the same result from the DB.
//
// Dates are rebuilt from the passed ISO strings before the call; the
// display label (e.g. "Today, 4:00 – 5:00 PM") is precomputed on the
// server so this component does no timezone math.

export type ConfirmableBlock = {
  id: string;
  programId: string;
  programName: string;
  startIso: string;
  endIso: string;
  whenLabel: string;
  overdue: boolean;
};

export type CoachOption = {
  id: string;
  name: string;
};

export function ScheduleConfirmList({
  blocks,
  coaches,
}: {
  blocks: ConfirmableBlock[];
  coaches: CoachOption[];
}) {
  // IDs the coach has resolved this session (confirmed, handed off, or
  // marked not-worked) → filtered out of the rendered list (adjust-during-
  // render, no effect).
  const [resolvedIds, setResolvedIds] = useState<Set<string>>(() => new Set());

  const visible = blocks.filter((b) => !resolvedIds.has(b.id));
  if (visible.length === 0) return null;

  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <p className="text-[11.5px] font-semibold uppercase tracking-[0.14em] text-fg-muted">
          Confirm your scheduled hours
        </p>
        <p className="text-sm text-fg-muted">
          Your scheduled work hours — confirm each once it&rsquo;s done, or
          say if you didn&rsquo;t work it.
        </p>
      </div>

      <ul className="space-y-2.5">
        {visible.map((block) => (
          <ConfirmCard
            key={block.id}
            block={block}
            coaches={coaches}
            onResolved={() =>
              setResolvedIds((prev) => {
                const next = new Set(prev);
                next.add(block.id);
                return next;
              })
            }
          />
        ))}
      </ul>
    </section>
  );
}

type CardMode = "idle" | "handoff" | "nocover";

function ConfirmCard({
  block,
  coaches,
  onResolved,
}: {
  block: ConfirmableBlock;
  coaches: CoachOption[];
  onResolved: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<CardMode>("idle");
  const [toCoachId, setToCoachId] = useState("");
  const [note, setNote] = useState("");

  const canHandOff = coaches.length > 0;

  const run = (op: () => Promise<unknown>, friendlyError: string) => {
    setError(null);
    startTransition(async () => {
      try {
        await op();
        onResolved();
      } catch {
        // Server actions redact thrown error details in production, so we
        // show a friendly, actionable message and leave the card so the
        // coach can retry or use the manual form below.
        setError(friendlyError);
      }
    });
  };

  const handleConfirm = () =>
    run(
      () =>
        logOwnHour({
          programId: block.programId,
          startAt: new Date(block.startIso),
          endAt: new Date(block.endIso),
          // 1b security B: the auto-confirm hotlink is TRUSTED — it carries
          // the block's exact times, so it skips the manual anomaly check
          // and always posts immediately.
          source: "schedule-confirm",
        }),
      "Couldn't log these hours — the work may no longer be active. Try again, or use the manual form below.",
    );

  const handleHandOff = () => {
    if (!toCoachId) return;
    run(
      () => reassignOwnBlock({ blockId: block.id, toCoachId }),
      "Couldn't hand off this shift — try again, or ask an admin.",
    );
  };

  const handleNoCover = () =>
    run(
      () => cancelOwnBlock({ blockId: block.id, note }),
      "Couldn't update this shift — try again, or ask an admin.",
    );

  return (
    <li className="rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)] p-3.5">
      <div className="flex items-center gap-3">
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gold/10 text-gold-strong">
          <CalendarClock className="h-4.5 w-4.5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="truncate text-sm font-semibold text-fg">
              {block.programName}
            </span>
            {block.overdue ? (
              <span className="shrink-0 inline-flex items-center rounded-full border border-danger/30 bg-danger/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-danger">
                Overdue
              </span>
            ) : null}
          </div>
          <p className="text-xs text-fg-muted tabular-nums">
            {block.whenLabel}
          </p>
        </div>
        <button
          type="button"
          onClick={handleConfirm}
          disabled={pending}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-gold px-3.5 h-9 text-sm font-semibold text-gold-ink shadow-[var(--shadow-sm)] hover:bg-gold-hover disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
        >
          <Check className="h-4 w-4" strokeWidth={2.5} aria-hidden="true" />
          {pending && mode === "idle" ? "Confirming…" : "Confirm these hours"}
        </button>
      </div>

      {/* Secondary actions for a shift the coach DIDN'T work. */}
      {mode === "idle" ? (
        <div className="mt-2.5 flex items-center gap-3 pl-12 text-xs">
          {canHandOff ? (
            <button
              type="button"
              onClick={() => {
                setError(null);
                setMode("handoff");
              }}
              disabled={pending}
              className="font-medium text-fg-muted hover:text-fg underline-offset-2 hover:underline disabled:opacity-50 transition-colors"
            >
              Gave it to another coach
            </button>
          ) : null}
          {canHandOff ? <span className="text-fg-subtle">·</span> : null}
          <button
            type="button"
            onClick={() => {
              setError(null);
              setMode("nocover");
            }}
            disabled={pending}
            className="font-medium text-fg-muted hover:text-fg underline-offset-2 hover:underline disabled:opacity-50 transition-colors"
          >
            Didn&rsquo;t work it
          </button>
        </div>
      ) : null}

      {/* Hand-off: pick the coach who took the shift. */}
      {mode === "handoff" ? (
        <div className="mt-3 space-y-2.5 border-t border-line pt-3">
          <p className="text-xs font-medium text-fg-muted">
            Who did you give this shift to?
          </p>
          <div className="relative">
            <select
              value={toCoachId}
              onChange={(e) => setToCoachId(e.target.value)}
              disabled={pending}
              aria-label="Coach who took the shift"
              className="w-full appearance-none rounded-lg bg-surface border border-line text-fg px-3 h-10 pr-8 text-sm focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40 disabled:opacity-50"
            >
              <option value="" disabled>
                Choose a coach…
              </option>
              {coaches.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <ChevronDown
              aria-hidden
              className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-fg-subtle"
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleHandOff}
              disabled={pending || !toCoachId}
              className="inline-flex items-center gap-1.5 rounded-lg bg-gold px-3.5 h-9 text-sm font-semibold text-gold-ink shadow-[var(--shadow-sm)] hover:bg-gold-hover disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
            >
              <UserPlus className="h-4 w-4" strokeWidth={2.5} aria-hidden="true" />
              {pending ? "Handing off…" : "Hand off shift"}
            </button>
            <CancelMode disabled={pending} onClick={() => setMode("idle")} />
          </div>
        </div>
      ) : null}

      {/* No cover: optional reason, then mark not-worked. */}
      {mode === "nocover" ? (
        <div className="mt-3 space-y-2.5 border-t border-line pt-3">
          <p className="text-xs font-medium text-fg-muted">
            Mark this shift as not worked? Your admin will see it for review.
          </p>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={pending}
            rows={2}
            maxLength={500}
            placeholder="Reason (optional)"
            className="w-full rounded-lg bg-surface border border-line text-fg placeholder:text-fg-subtle px-3 py-2 text-sm focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40 resize-none disabled:opacity-50"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleNoCover}
              disabled={pending}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong bg-surface-2 px-3.5 h-9 text-sm font-semibold text-fg hover:bg-surface disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
            >
              {pending ? "Saving…" : "Didn't work it"}
            </button>
            <CancelMode disabled={pending} onClick={() => setMode("idle")} />
          </div>
        </div>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="mt-2.5 rounded-md border border-danger/30 bg-danger/10 px-2.5 py-2 text-xs text-danger"
        >
          {error}
        </p>
      ) : null}
    </li>
  );
}

function CancelMode({
  disabled,
  onClick,
}: {
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1 rounded-lg px-2 h-9 text-sm font-medium text-fg-muted hover:text-fg hover:bg-surface-2 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
    >
      <X className="h-4 w-4" aria-hidden="true" />
      Cancel
    </button>
  );
}
