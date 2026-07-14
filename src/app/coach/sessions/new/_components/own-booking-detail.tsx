"use client";

// Coach "your booking" detail popup — opened by tapping a gold (own) slot on
// the booking calendar (works identically on the mobile list + desktop grid).
//
// Read-only detail (resource / when / note) plus ONE context-aware action:
//   • future rental  → Delete rental (hard delete, confirmed)
//   • started rental → Request removal (admin-approved; it's money owed)
//   • pending request → a "Removal requested" chip (no action)
//
// The server enforces all of this (deleteOwnSession rejects a started rental
// with PastRentalImmutableError; requestOwnSessionRemoval rejects a future
// one) — the UI just shows the right affordance and degrades gracefully if
// the boundary is crossed while the popup is open.

import { useEffect, useState, useTransition } from "react";
import { Clock3, Trash2, X } from "lucide-react";
import { deleteOwnSessionAction } from "../../form-actions";
import { ConfirmDialog } from "@/app/_components/confirm-dialog";
import {
  RequestRemovalDialog,
  type RemovableSession,
} from "../../_components/request-removal-dialog";
import { PFA_TIMEZONE } from "@/lib/timezone";

export type OwnBookingInfo = {
  sessionId: string;
  resourceName: string;
  startAt: Date;
  endAt: Date;
  note: string | null;
  removalPending: boolean;
  // Computed at open time (startAt <= now) — a started rental can only be
  // removed via admin request, not deleted directly. The server re-checks, so
  // a boundary crossed while the popup is open degrades gracefully.
  isPast: boolean;
};

export function OwnBookingDetail({
  info,
  onClose,
  onChanged,
}: {
  /** The tapped own booking, or null when the popup is closed. */
  info: OwnBookingInfo | null;
  onClose: () => void;
  /** Refetch the day after a delete / removal request so the slot updates. */
  onChanged: () => void;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [requestingRemoval, setRequestingRemoval] = useState(false);
  const [isDeleting, startDelete] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const open = info !== null;

  // Transient state resets across opens via the `key` the parent sets on this
  // component (keyed by sessionId), so no reset-on-open effect is needed.

  // ESC closes the popup — but only when no nested dialog owns the ESC and
  // we're not mid-delete (the nested dialogs handle their own ESC).
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (confirmingDelete || requestingRemoval || isDeleting) return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, confirmingDelete, requestingRemoval, isDeleting, onClose]);

  if (!info) return null;

  const isPast = info.isPast;

  const handleDelete = () => {
    setError(null);
    startDelete(async () => {
      try {
        await deleteOwnSessionAction(info.sessionId);
        setConfirmingDelete(false);
        onChanged();
        onClose();
      } catch {
        // The rental just crossed its start time, or was already removed by
        // an admin. Don't throw to the route boundary — re-sync + explain.
        setConfirmingDelete(false);
        setError(
          "Couldn't delete this rental — it may have just started or already been removed. Refreshing…",
        );
        onChanged();
      }
    });
  };

  const backdropClose = () => {
    if (confirmingDelete || requestingRemoval || isDeleting) return;
    onClose();
  };

  const removable: RemovableSession = {
    id: info.sessionId,
    resourceName: info.resourceName,
    startAt: info.startAt,
    endAt: info.endAt,
  };

  return (
    <>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Your booking"
        className="fixed inset-0 z-40 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
        onClick={backdropClose}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-md rounded-2xl border border-line bg-surface shadow-[var(--shadow-lg)]"
        >
          {/* Header */}
          <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-line">
            <div>
              <p className="text-[11.5px] font-semibold uppercase tracking-[0.14em] text-fg-muted">
                Your booking
              </p>
              <h4 className="mt-0.5 text-base font-semibold text-fg">
                {info.resourceName}
              </h4>
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={isDeleting}
              className="inline-flex items-center justify-center h-8 w-8 -mr-1 -mt-1 rounded-lg text-fg-muted hover:text-fg hover:bg-surface-2 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Read-only detail */}
          <div className="px-5 py-4 space-y-3">
            <div>
              <p className="text-[11px] uppercase tracking-wider text-fg-muted">
                When
              </p>
              <p className="mt-0.5 text-sm font-medium tabular-nums text-fg">
                {formatWhen(info.startAt, info.endAt)}
              </p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wider text-fg-muted">
                Note
              </p>
              <p className="mt-0.5 text-sm text-fg-muted leading-snug whitespace-pre-wrap break-words">
                {info.note?.trim() ? info.note : "—"}
              </p>
            </div>

            {error ? (
              <div
                role="alert"
                className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
              >
                {error}
              </div>
            ) : null}
          </div>

          {/* Action footer — one context-aware control */}
          <div className="px-5 py-4 border-t border-line flex items-center justify-between gap-2">
            {info.removalPending ? (
              <span
                className="inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-surface-2 px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-fg-muted"
                title="An admin will review this removal request"
              >
                <Clock3 className="h-3.5 w-3.5" />
                Removal requested
              </span>
            ) : isPast ? (
              <button
                type="button"
                onClick={() => setRequestingRemoval(true)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong bg-surface text-fg-muted hover:text-danger hover:border-danger/40 h-9 px-3 text-sm font-medium shadow-[var(--shadow-sm)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 transition"
              >
                <Clock3 className="h-4 w-4" />
                Request removal
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmingDelete(true)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-danger/40 bg-danger/5 text-danger hover:bg-danger/10 h-9 px-3 text-sm font-medium shadow-[var(--shadow-sm)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 transition"
              >
                <Trash2 className="h-4 w-4" />
                Delete rental
              </button>
            )}

            <button
              type="button"
              onClick={onClose}
              disabled={isDeleting}
              className="inline-flex items-center justify-center rounded-lg border border-line-strong bg-surface text-fg-muted hover:text-fg hover:-translate-y-px h-9 px-4 text-sm font-medium shadow-[var(--shadow-sm)] hover:shadow-[var(--shadow-md)] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition"
            >
              Close
            </button>
          </div>
        </div>
      </div>

      {/* Delete confirmation (future rentals) — fixed overlay stacks above
          this popup (z-50 > z-40). */}
      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={(next) => {
          if (!next) setConfirmingDelete(false);
        }}
        title="Delete this rental?"
        description={`${info.resourceName} · ${formatWhen(info.startAt, info.endAt)}. This can't be undone.`}
        confirmLabel={isDeleting ? "Deleting…" : "Delete rental"}
        variant="danger"
        onConfirm={handleDelete}
        isPending={isDeleting}
      />

      {/* Removal request (started rentals). */}
      <RequestRemovalDialog
        session={requestingRemoval ? removable : null}
        onClose={() => setRequestingRemoval(false)}
        onSubmitted={() => {
          onChanged();
          onClose();
        }}
      />
    </>
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
