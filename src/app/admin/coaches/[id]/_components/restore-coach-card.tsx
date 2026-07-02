"use client";

// QA-2 restore-coach card. Shown at the bottom of /admin/coaches/[id]
// ONLY when the coach is ARCHIVED — it replaces the DeleteCoachCard
// (Archive danger zone). Restore is the single mutation allowed on an
// archived coach: it clears users.deletedAt, the coach returns to the
// active roster with name/email intact, and the page re-renders fully
// editable again.
//
// Mirrors the archive-coaches-client Restore flow (confirm dialog →
// restoreCoach), but scoped to this one coach. The public restoreCoach
// action is requireRole("admin")-gated and no-ops on an already-active /
// unknown id, so a stray double-click can't error. On success we
// router.refresh() so the same URL re-renders as the active (editable)
// detail page.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArchiveRestore } from "lucide-react";
import { restoreCoach } from "../../actions";
import { ConfirmDialog } from "@/app/_components/confirm-dialog";

export function RestoreCoachCard({
  coachId,
  coachName,
}: {
  coachId: string;
  coachName: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const handleOpenChange = (next: boolean) => {
    if (pending) return;
    setOpen(next);
    if (!next) setError(null);
  };

  const handleConfirm = () => {
    setError(null);
    startTransition(async () => {
      try {
        await restoreCoach(coachId);
        // Same URL, now an active coach → re-render editable. refresh()
        // (not push) keeps the admin on this coach's page.
        router.refresh();
        setOpen(false);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Couldn't restore this coach. Please try again.",
        );
      }
    });
  };

  return (
    <div className="mt-8 rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)] overflow-hidden">
      <div className="px-5 py-4 border-b border-line bg-surface-2/60">
        <p className="text-[11.5px] font-semibold uppercase tracking-[0.14em] text-fg-muted">
          Archived
        </p>
        <h3 className="mt-1 text-base font-semibold text-fg">Restore coach</h3>
        <p className="mt-1.5 text-xs text-fg-muted leading-relaxed">
          Bring this coach back to the active roster with their name, email,
          and all past session and billing rows intact. Once restored they can
          sign in again and this page becomes editable.
        </p>
      </div>
      <div className="px-5 py-4 flex items-center justify-between gap-4">
        <p className="text-xs text-fg-muted">
          Restoring re-enables sign-in and editing for this coach.
        </p>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-gold text-gold-ink hover:bg-gold-hover shadow-[var(--shadow-sm)] h-9 px-3 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
        >
          <ArchiveRestore className="h-3.5 w-3.5" />
          Restore coach
        </button>
      </div>

      <ConfirmDialog
        open={open}
        onOpenChange={handleOpenChange}
        variant="default"
        title="Restore this coach?"
        description={
          <>
            <p>
              {coachName ?? "This coach"} returns to the active Coaches list
              with their name and email intact, can sign back in, and this page
              becomes editable again.
            </p>
            {error ? (
              <p role="alert" className="mt-2 font-medium text-danger">
                {error}
              </p>
            ) : null}
          </>
        }
        confirmLabel={pending ? "Restoring…" : "Restore coach"}
        onConfirm={handleConfirm}
        isPending={pending}
      />
    </div>
  );
}
