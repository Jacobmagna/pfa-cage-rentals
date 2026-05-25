"use client";

// Merge dialog for synthetic (import-created) coaches. Picker over
// the real-coach roster; on submit, re-points every sessions_billing
// row from source → target then deletes the synthetic. Audit log
// captures both. Re-runnable: if a previous merge died half-way,
// re-running it cleans up the leftover empty synthetic.
//
// We don't show a confirmation modal here — the dialog itself is
// the confirmation, and the user actively picked a target. The
// pending state on the button + the "this can't be undone except
// from the R2 backup" hint do the work.

import { useEffect, useRef, useState, useTransition } from "react";
import { X } from "lucide-react";
import { mergeSyntheticCoach } from "../actions";
import type { CoachRow, MergeTarget } from "./coaches-table";

export function MergeCoachDialog({
  open,
  onClose,
  source,
  targets,
}: {
  open: boolean;
  onClose: () => void;
  source: CoachRow | null;
  targets: MergeTarget[];
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [targetId, setTargetId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handler = () => {
      if (open) onClose();
    };
    dialog.addEventListener("close", handler);
    return () => dialog.removeEventListener("close", handler);
  }, [open, onClose]);

  // Reset picker + error on each open.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open && !prevOpen) {
      setTargetId("");
      setError(null);
    }
  }

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!source || !targetId) return;
    setError(null);
    startTransition(async () => {
      try {
        await mergeSyntheticCoach(source.id, targetId);
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Merge failed");
      }
    });
  };

  // Exclude the source from the target list (defensive — server also
  // rejects self-merge, but UI shouldn't even offer it).
  const eligibleTargets = source
    ? targets.filter((t) => t.id !== source.id)
    : targets;

  return (
    <dialog
      ref={dialogRef}
      className="m-auto w-full max-w-md rounded-lg border border-line bg-surface text-fg p-0 backdrop:bg-page/70 backdrop:backdrop-blur-sm"
    >
      <form onSubmit={onSubmit} className="space-y-5 p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.14em] text-fg-muted">
              Merge
            </p>
            <h2 className="text-xl font-semibold tracking-tight mt-0.5">
              Move sessions to a real coach
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center justify-center h-8 w-8 -mr-1 -mt-1 rounded-md text-fg-muted hover:text-fg hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {source ? (
          <div className="rounded-md border border-line bg-page px-3 py-2.5 text-sm">
            <p className="text-xs uppercase tracking-wider text-fg-muted mb-1">
              From
            </p>
            <p className="font-medium text-fg">
              {source.name ?? source.email}
            </p>
            <p className="text-xs text-fg-subtle mt-0.5">
              {source.sessionsThisMonth} session
              {source.sessionsThisMonth === 1 ? "" : "s"} this month · imported
            </p>
          </div>
        ) : null}

        <label className="block">
          <span className="text-xs uppercase tracking-wider text-fg-muted block mb-1.5">
            Into real coach
          </span>
          <select
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            required
            className="w-full rounded-md bg-page border border-line text-fg px-3 h-10 text-sm appearance-none pr-8 focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40"
          >
            <option value="" disabled>
              Choose a coach…
            </option>
            {eligibleTargets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name ?? t.email}
              </option>
            ))}
          </select>
          <span className="block text-[11px] text-fg-subtle mt-1.5 leading-snug">
            All sessions move to the chosen coach. The imported coach is
            deleted. The R2 nightly backup is the only undo path.
          </span>
        </label>

        {error ? (
          <div
            role="alert"
            className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
          >
            {error}
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-line bg-surface-2 text-fg-muted hover:text-fg hover:border-line-strong h-9 px-4 text-sm font-medium transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={pending || !targetId}
            className="rounded-md bg-gold text-gold-ink hover:bg-gold-hover h-9 px-4 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
          >
            {pending ? "Merging…" : "Merge"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
