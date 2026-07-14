"use client";

// 1b security: a coach can't delete a PAST rental directly — it's money they
// owe PFA, so removal is admin-approved. This small dialog collects an
// optional "why it didn't happen" reason and files the request via the
// ownership-gated server action. Shared by BOTH the "My rentals" list and the
// booking-calendar "your booking" popup so the removal-request UX has exactly
// one source (no drift on a money surface).

import { useEffect, useRef, useState, useTransition } from "react";
import { requestOwnSessionRemovalAction } from "../form-actions";
import { PFA_TIMEZONE } from "@/lib/timezone";

export type RemovableSession = {
  id: string;
  resourceName: string;
  startAt: Date;
  endAt: Date;
};

export function RequestRemovalDialog({
  session,
  onClose,
  onSubmitted,
}: {
  /** The rental to request removal for, or null when the dialog is closed. */
  session: RemovableSession | null;
  onClose: () => void;
  /** Fired after a successful submit (before onClose) so a caller can
      refetch — e.g. the booking calendar re-pulls the day so the slot now
      shows "Removal requested". The "My rentals" list relies on the action's
      own revalidatePath instead and can omit this. */
  onSubmitted?: () => void;
}) {
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();
  const cancelRef = useRef<HTMLButtonElement>(null);

  const open = session !== null;

  // Reset the reason + focus Cancel each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReason("");
    const t = requestAnimationFrame(() => cancelRef.current?.focus());
    return () => cancelAnimationFrame(t);
  }, [open]);

  // ESC dismiss (unless mid-submit).
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pending) {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, pending, onClose]);

  if (!session) return null;

  const handleSubmit = () => {
    startTransition(async () => {
      await requestOwnSessionRemovalAction(session.id, reason.trim() || null);
      onSubmitted?.();
      onClose();
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Request rental removal"
      className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
      onClick={() => {
        if (!pending) onClose();
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl border border-line bg-surface shadow-[var(--shadow-lg)]"
      >
        <div className="px-5 py-4 border-b border-line">
          <h4 className="text-base font-semibold text-fg">
            Request removal of this rental?
          </h4>
          <p className="mt-1 text-xs text-fg-muted leading-relaxed">
            {session.resourceName} · {formatWhen(session.startAt, session.endAt)}.
            This rental has already started, so it can&apos;t be deleted
            directly — an admin will review your request.
          </p>
        </div>

        <div className="px-5 py-4">
          <label className="block">
            <span className="flex items-baseline justify-between mb-1.5">
              <span className="text-xs uppercase tracking-wider text-fg-muted">
                Reason
              </span>
              <span className="text-[10px] text-fg-subtle">optional</span>
            </span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={pending}
              rows={3}
              maxLength={500}
              placeholder="What happened? (e.g. the rental didn't happen)"
              className="w-full rounded-lg bg-page border border-line text-fg placeholder:text-fg-subtle px-3 py-2 text-sm focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40 resize-none"
            />
          </label>
        </div>

        <div className="px-5 py-4 border-t border-line flex items-center justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onClose}
            disabled={pending}
            className="inline-flex items-center justify-center rounded-lg border border-line-strong bg-surface text-fg-muted hover:text-fg hover:-translate-y-px h-9 px-3 text-sm font-medium shadow-[var(--shadow-sm)] hover:shadow-[var(--shadow-md)] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={pending}
            className="inline-flex items-center justify-center rounded-lg bg-gold text-gold-ink hover:bg-gold-hover shadow-[var(--shadow-sm)] h-9 px-3 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
          >
            {pending ? "Submitting…" : "Request removal"}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatWhen(start: Date, end: Date): string {
  const date = start.toLocaleDateString("en-US", {
    timeZone: PFA_TIMEZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const opts: Intl.DateTimeFormatOptions = {
    timeZone: PFA_TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
  };
  return `${date} · ${start.toLocaleTimeString("en-US", opts)} – ${end.toLocaleTimeString("en-US", opts)}`;
}
