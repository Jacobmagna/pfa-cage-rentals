"use client";

// 1b security B: Approve/Reject buttons for one held manual work-log in the
// admin approval queue. Approve is the POSITIVE path (flips the log to posted
// → payable + counted), so it uses the default ConfirmDialog tone. Reject is
// DESTRUCTIVE (it deletes the row; the coach must re-enter), so it uses the
// danger dialog with an optional admin note. Kept as a small client island so
// the queue table shell stays a server component. Mirrors the cage-rental
// removal-request row actions.

import { useEffect, useRef, useState, useTransition } from "react";
import { Check, FileText, X } from "lucide-react";
import {
  approveHeldHourLog,
  rejectHeldHourLog,
} from "@/app/admin/hour-log/actions";
import { ConfirmDialog } from "@/app/_components/confirm-dialog";
import { HeldDetailsDialog } from "./held-details-dialog";

export function HeldRowActions({
  id,
  coachLabel,
  whenLabel,
}: {
  id: string;
  coachLabel: string;
  whenLabel: string;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const [confirmApprove, setConfirmApprove] = useState(false);
  const [confirmReject, setConfirmReject] = useState(false);
  const [isPending, startTransition] = useTransition();

  const handleApprove = () => {
    startTransition(async () => {
      await approveHeldHourLog(id);
      setConfirmApprove(false);
    });
  };

  return (
    <div className="flex items-center justify-end gap-2">
      <button
        type="button"
        onClick={() => setShowDetails(true)}
        disabled={isPending}
        className="inline-flex items-center gap-1 rounded-lg border border-line-strong bg-surface px-2.5 h-8 text-xs font-medium text-fg-muted hover:text-fg hover:bg-surface-2 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
      >
        <FileText className="h-3.5 w-3.5" />
        Details
      </button>
      <button
        type="button"
        onClick={() => setConfirmApprove(true)}
        disabled={isPending}
        className="inline-flex items-center gap-1 rounded-lg border border-line-strong bg-gold/10 px-2.5 h-8 text-xs font-medium text-fg hover:bg-gold/20 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
      >
        <Check className="h-3.5 w-3.5" />
        Approve
      </button>
      <button
        type="button"
        onClick={() => setConfirmReject(true)}
        disabled={isPending}
        className="inline-flex items-center gap-1 rounded-lg border border-danger/30 bg-danger/10 px-2.5 h-8 text-xs font-medium text-danger hover:bg-danger/20 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 transition-colors"
      >
        <X className="h-3.5 w-3.5" />
        Reject
      </button>

      <HeldDetailsDialog
        open={showDetails}
        onClose={() => setShowDetails(false)}
        logId={id}
        coachLabel={coachLabel}
        whenLabel={whenLabel}
        onReject={() => {
          setShowDetails(false);
          setConfirmReject(true);
        }}
      />

      <ConfirmDialog
        open={confirmApprove}
        onOpenChange={(next) => {
          if (!next) setConfirmApprove(false);
        }}
        title="Approve this work log?"
        description={
          <>
            This makes {coachLabel}&apos;s log ({whenLabel}) a real, payable
            entry — it will count on reports and pay totals.
          </>
        }
        confirmLabel={isPending ? "Approving…" : "Approve & post"}
        variant="default"
        onConfirm={handleApprove}
        isPending={isPending}
      />

      <RejectDialog
        open={confirmReject}
        onClose={() => setConfirmReject(false)}
        id={id}
        coachLabel={coachLabel}
        whenLabel={whenLabel}
      />
    </div>
  );
}

// Reject deletes the held row (the coach must re-enter corrected data). Danger
// tone, with an optional admin note. The ConfirmDialog only does typed
// confirmation, not free text, so this small dialog mirrors its chrome and
// adds a note textarea — same pattern as the removal-request deny dialog.
function RejectDialog({
  open,
  onClose,
  id,
  coachLabel,
  whenLabel,
}: {
  open: boolean;
  onClose: () => void;
  id: string;
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

  const handleReject = () => {
    startTransition(async () => {
      await rejectHeldHourLog(id, note.trim() || undefined);
      onClose();
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Reject held work log"
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
            Reject this work log?
          </h4>
          <p className="mt-1 text-xs text-fg-muted leading-relaxed">
            {coachLabel}&apos;s log ({whenLabel}) is deleted — the coach will
            need to re-enter corrected hours. This can&apos;t be undone. You
            can add a note for the record.
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
              placeholder="Why the log was rejected"
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
            onClick={handleReject}
            disabled={isPending}
            className="inline-flex items-center justify-center rounded-lg border border-danger/30 bg-danger/10 text-danger hover:bg-danger/20 h-9 px-3 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 transition-colors"
          >
            {isPending ? "Rejecting…" : "Reject & delete"}
          </button>
        </div>
      </div>
    </div>
  );
}
