"use client";

import { useState, useTransition } from "react";
import { CalendarClock, Check } from "lucide-react";
import { logOwnHour } from "../actions";

// QA10 W3.7 — "Confirm your scheduled hours". One card per scheduled
// program block whose end is within 15 min of now (the server filters
// to those via isBlockConfirmable + drops blocks already logged). Each
// card has a one-click "Confirm these hours" button that calls the
// existing logOwnHour action with the block's exact program + start/end.
//
// On success the card is removed from the LOCAL list (a pure render-time
// filter over confirmedIds + failed… kept in component state — no
// setState-in-effect) and the page revalidates (logOwnHour revalidates
// /coach/hour-log) so a refresh shows the same result from the DB.
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
};

export function ScheduleConfirmList({
  blocks,
}: {
  blocks: ConfirmableBlock[];
}) {
  // IDs the coach has successfully confirmed this session → filtered out
  // of the rendered list (adjust-during-render, no effect).
  const [confirmedIds, setConfirmedIds] = useState<Set<string>>(
    () => new Set(),
  );

  const visible = blocks.filter((b) => !confirmedIds.has(b.id));
  if (visible.length === 0) return null;

  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <p className="text-[11.5px] font-semibold uppercase tracking-[0.14em] text-fg-muted">
          Confirm your scheduled hours
        </p>
        <p className="text-sm text-fg-muted">
          These blocks just wrapped up. One tap logs the hours exactly as
          scheduled.
        </p>
      </div>

      <ul className="space-y-2.5">
        {visible.map((block) => (
          <ConfirmCard
            key={block.id}
            block={block}
            onConfirmed={() =>
              setConfirmedIds((prev) => {
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

function ConfirmCard({
  block,
  onConfirmed,
}: {
  block: ConfirmableBlock;
  onConfirmed: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = () => {
    setError(null);
    startTransition(async () => {
      try {
        await logOwnHour({
          programId: block.programId,
          startAt: new Date(block.startIso),
          endAt: new Date(block.endIso),
        });
        onConfirmed();
      } catch {
        // Server actions redact thrown error details in production, so we
        // can't reliably read the specific code on the client. Show a
        // friendly, actionable message and leave the card so the coach
        // can retry or fall back to the manual form below.
        setError(
          "Couldn't log these hours — the program may no longer be active. Try again, or use the manual form below.",
        );
      }
    });
  };

  return (
    <li className="rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)] p-3.5">
      <div className="flex items-center gap-3">
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gold/10 text-gold-strong">
          <CalendarClock className="h-4.5 w-4.5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-fg">
            {block.programName}
          </p>
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
          {pending ? "Confirming…" : "Confirm these hours"}
        </button>
      </div>
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
