"use client";

// Coach cancel-reasons: a coach can now cancel a rental at ANY time (the old
// admin-approved removal flow is retired). For a rental that has already
// STARTED or is over (isPast), a reason is REQUIRED for accountability — this
// dialog collects it via a required <select> (the 6 canonical reasons) plus a
// conditional free-text box when "Other" is chosen. A FUTURE rental keeps the
// plain one-tap ConfirmDialog delete with NO reason (handled by the callers).
//
// The reason is shared with the admins (surfaced on the accountability rollup).
// Mirrors the fixed-overlay chrome + a11y of request-removal-dialog.tsx so the
// coach cancel surfaces stay visually consistent. Shared by BOTH the "My
// rentals" history list and the booking-calendar "your booking" popup so the
// reason UX has exactly one source (no drift on a money surface).

import { useEffect, useRef, useState, useTransition } from "react";
import { deleteOwnSessionAction } from "../form-actions";
import {
  CANCEL_REASONS,
  CANCEL_REASON_LABELS,
} from "@/lib/schemas/session";
import { PFA_TIMEZONE } from "@/lib/timezone";

export type CancellableSession = {
  id: string;
  resourceName: string;
  startAt: Date;
  endAt: Date;
};

export function CancelWithReasonDialog({
  session,
  onClose,
  onSubmitted,
}: {
  /** The started/past rental to cancel, or null when the dialog is closed. */
  session: CancellableSession | null;
  onClose: () => void;
  /** Fired after a successful cancel (before onClose) so a caller can refetch —
      e.g. the booking calendar re-pulls the day. The "My rentals" list relies
      on the action's own revalidatePath instead and can omit this. */
  onSubmitted?: () => void;
}) {
  const [reason, setReason] = useState("");
  const [reasonOther, setReasonOther] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const cancelRef = useRef<HTMLButtonElement>(null);

  const open = session !== null;

  // Reset the fields + focus Cancel each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReason("");
    setReasonOther("");
    setError(null);
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

  const isOther = reason === "other";
  // Confirm is enabled only when a reason is chosen AND, for "Other", the
  // trimmed free-text is non-empty. Mirrors the server's cancelWithReasonSchema
  // superRefine so the UI can't submit something the action will reject.
  const canConfirm = reason !== "" && (!isOther || reasonOther.trim() !== "");

  const handleSubmit = () => {
    if (!canConfirm || pending) return;
    setError(null);
    startTransition(async () => {
      try {
        await deleteOwnSessionAction(session.id, {
          reason,
          reasonOther: isOther ? reasonOther.trim() : null,
        });
        onSubmitted?.();
        onClose();
      } catch {
        // Reason bypassed (CancelReasonRequiredError) or the rental was
        // already removed. Don't throw to the route boundary — explain inline.
        setError(
          "Couldn't cancel this rental — pick a reason and try again, or it may have already been removed.",
        );
      }
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Cancel rental"
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
            Cancel this rental?
          </h4>
          <p className="mt-1 text-xs text-fg-muted leading-relaxed">
            {session.resourceName} · {formatWhen(session.startAt, session.endAt)}
            . This can&apos;t be undone, and the reason is shared with the
            admins.
          </p>
        </div>

        <div className="px-5 py-4 space-y-3">
          <label className="block">
            <span className="flex items-baseline justify-between mb-1.5">
              <span className="text-xs uppercase tracking-wider text-fg-muted">
                Reason
              </span>
              <span className="text-[10px] text-fg-subtle">required</span>
            </span>
            <select
              aria-label="Reason for cancelling"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={pending}
              className="w-full rounded-lg bg-page border border-line text-fg px-3 h-10 text-sm focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40 disabled:opacity-50"
            >
              <option value="" disabled>
                Select a reason…
              </option>
              {CANCEL_REASONS.map((key) => (
                <option key={key} value={key}>
                  {CANCEL_REASON_LABELS[key]}
                </option>
              ))}
            </select>
          </label>

          {isOther ? (
            <label className="block">
              <span className="flex items-baseline justify-between mb-1.5">
                <span className="text-xs uppercase tracking-wider text-fg-muted">
                  Detail
                </span>
                <span className="text-[10px] text-fg-subtle">required</span>
              </span>
              <textarea
                value={reasonOther}
                onChange={(e) => setReasonOther(e.target.value)}
                disabled={pending}
                rows={3}
                maxLength={500}
                placeholder="Add detail…"
                className="w-full rounded-lg bg-page border border-line text-fg placeholder:text-fg-subtle px-3 py-2 text-sm focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40 resize-none"
              />
            </label>
          ) : null}

          {error ? (
            <div
              role="alert"
              className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
            >
              {error}
            </div>
          ) : null}
        </div>

        <div className="px-5 py-4 border-t border-line flex items-center justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onClose}
            disabled={pending}
            className="inline-flex items-center justify-center rounded-lg border border-line-strong bg-surface text-fg-muted hover:text-fg hover:-translate-y-px h-9 px-3 text-sm font-medium shadow-[var(--shadow-sm)] hover:shadow-[var(--shadow-md)] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition"
          >
            Keep rental
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canConfirm || pending}
            className="inline-flex items-center justify-center rounded-lg bg-danger text-page hover:opacity-90 shadow-[var(--shadow-sm)] h-9 px-3 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 transition"
          >
            {pending ? "Cancelling…" : "Cancel rental"}
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
