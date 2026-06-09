"use client";

// 1b security: Approve/Deny buttons for one pending removal request in the
// admin queue. Approve is the DESTRUCTIVE path (it hard-deletes the rental),
// so it uses the danger ConfirmDialog. Deny keeps the rental — default tone,
// with an optional admin note. Kept as a small client island so the table
// shell stays a server component.

import { useEffect, useRef, useState, useTransition } from "react";
import { Check, X } from "lucide-react";
import {
  approveSessionRemoval,
  denySessionRemoval,
} from "@/app/admin/sessions/actions";
import { ConfirmDialog } from "@/app/_components/confirm-dialog";

export function RemovalRequestRowActions({
  requestId,
  coachLabel,
  whenLabel,
}: {
  requestId: string;
  coachLabel: string;
  whenLabel: string;
}) {
  const [confirmApprove, setConfirmApprove] = useState(false);
  const [confirmDeny, setConfirmDeny] = useState(false);
  const [isPending, startTransition] = useTransition();

  const handleApprove = () => {
    startTransition(async () => {
      await approveSessionRemoval(requestId);
      setConfirmApprove(false);
    });
  };

  return (
    <div className="flex items-center justify-end gap-2">
      <button
        type="button"
        onClick={() => setConfirmApprove(true)}
        disabled={isPending}
        className="inline-flex items-center gap-1 rounded-lg border border-danger/30 bg-danger/10 px-2.5 h-8 text-xs font-medium text-danger hover:bg-danger/20 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 transition-colors"
      >
        <Check className="h-3.5 w-3.5" />
        Approve
      </button>
      <button
        type="button"
        onClick={() => setConfirmDeny(true)}
        disabled={isPending}
        className="inline-flex items-center gap-1 rounded-lg border border-line-strong bg-surface px-2.5 h-8 text-xs font-medium text-fg-muted hover:text-fg hover:bg-surface-2 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
      >
        <X className="h-3.5 w-3.5" />
        Deny
      </button>

      <ConfirmDialog
        open={confirmApprove}
        onOpenChange={(next) => {
          if (!next) setConfirmApprove(false);
        }}
        title="Approve removal & delete rental?"
        description={
          <>
            This deletes {coachLabel}&apos;s rental ({whenLabel}) for good and
            records it on the cancellations log. This can&apos;t be undone.
          </>
        }
        confirmLabel={isPending ? "Removing…" : "Approve & delete"}
        variant="danger"
        onConfirm={handleApprove}
        isPending={isPending}
      />

      <DenyDialog
        open={confirmDeny}
        onClose={() => setConfirmDeny(false)}
        requestId={requestId}
        coachLabel={coachLabel}
        whenLabel={whenLabel}
      />
    </div>
  );
}

// Deny keeps the rental. Default tone, with an optional admin note (the
// ConfirmDialog only does typed-confirmation, not free text, so this small
// dialog mirrors its chrome and adds a note textarea).
function DenyDialog({
  open,
  onClose,
  requestId,
  coachLabel,
  whenLabel,
}: {
  open: boolean;
  onClose: () => void;
  requestId: string;
  coachLabel: string;
  whenLabel: string;
}) {
  const [note, setNote] = useState("");
  const [isPending, startTransition] = useTransition();
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNote("");
    const t = requestAnimationFrame(() => cancelRef.current?.focus());
    return () => cancelAnimationFrame(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isPending) {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, isPending, onClose]);

  if (!open) return null;

  const handleDeny = () => {
    startTransition(async () => {
      await denySessionRemoval(requestId, note.trim() || null);
      onClose();
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Deny removal request"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
      onClick={() => {
        if (!isPending) onClose();
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl border border-line bg-surface shadow-[var(--shadow-lg)]"
      >
        <div className="px-5 py-4 border-b border-line">
          <h4 className="text-base font-semibold text-fg">
            Deny this removal request?
          </h4>
          <p className="mt-1 text-xs text-fg-muted leading-relaxed">
            {coachLabel}&apos;s rental ({whenLabel}) stays as booked. You can
            add a note explaining why.
          </p>
        </div>

        <div className="px-5 py-4">
          <label className="block">
            <span className="flex items-baseline justify-between mb-1.5">
              <span className="text-xs uppercase tracking-wider text-fg-muted">
                Note to record
              </span>
              <span className="text-[10px] text-fg-subtle">optional</span>
            </span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={isPending}
              rows={3}
              maxLength={500}
              placeholder="Why the request was denied"
              className="w-full rounded-lg bg-page border border-line text-fg placeholder:text-fg-subtle px-3 py-2 text-sm focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40 resize-none"
            />
          </label>
        </div>

        <div className="px-5 py-4 border-t border-line flex items-center justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onClose}
            disabled={isPending}
            className="inline-flex items-center justify-center rounded-lg border border-line-strong bg-surface text-fg-muted hover:text-fg hover:-translate-y-px h-9 px-3 text-sm font-medium shadow-[var(--shadow-sm)] hover:shadow-[var(--shadow-md)] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleDeny}
            disabled={isPending}
            className="inline-flex items-center justify-center rounded-lg bg-gold text-gold-ink hover:bg-gold-hover shadow-[var(--shadow-sm)] h-9 px-3 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
          >
            {isPending ? "Denying…" : "Deny request"}
          </button>
        </div>
      </div>
    </div>
  );
}
