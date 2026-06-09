"use client";

// J9 delete-coach card. Lives at the bottom of /admin/coaches/[id]
// because (a) it's destructive and shouldn't compete with the rate-
// override editor for attention, (b) putting it in a "Danger zone"
// footer follows the same pattern as GitHub repo settings — the only
// place this kind of irreversible action belongs.
//
// Two layers of friction:
//   1. Disabled (with explanation) if target is an admin. We don't
//      delete admins via this surface — admin lifecycle is managed
//      via the hardcoded `isAdminEmail` allowlist.
//   2. Typed-confirmation modal: user must type the coach's exact
//      display name (or email if name is null) before the Delete
//      button enables. Matches the GitHub repo-delete pattern.
//
// Server already enforces every rule (requireRole, CannotDeleteAdmin
// throw) — the client gates are pure UX.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Archive } from "lucide-react";
import { archiveCoach } from "../actions";
import { ConfirmDialog } from "@/app/_components/confirm-dialog";

export function DeleteCoachCard({
  coachId,
  coachName,
  coachEmail,
  isAdmin,
}: {
  coachId: string;
  coachName: string | null;
  coachEmail: string;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // What the user has to type to confirm. Name when present (matches
  // what they see in the page header); falls back to email otherwise.
  const expected = (coachName ?? coachEmail).trim();

  const handleOpenChange = (next: boolean) => {
    if (pending) return;
    setOpen(next);
    if (!next) setError(null);
  };

  const handleConfirm = () => {
    setError(null);
    startTransition(async () => {
      try {
        await archiveCoach(coachId);
        router.push("/admin/coaches");
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Couldn't archive this coach. Please try again.",
        );
      }
    });
  };

  return (
    <div className="mt-8 rounded-xl border border-danger/30 bg-danger/5 shadow-[var(--shadow-sm)] overflow-hidden">
      <div className="px-5 py-4 border-b border-danger/20 bg-danger/10">
        <p className="text-[11.5px] font-semibold uppercase tracking-[0.14em] text-danger">
          Danger zone
        </p>
        <h3 className="mt-1 text-base font-semibold text-fg">
          Archive coach
        </h3>
        <p className="mt-1.5 text-xs text-fg-muted leading-relaxed">
          Removes this coach from active lists. Their name, email, and past
          session and billing rows are all kept. While archived they
          won&rsquo;t be able to sign in. This is reversible &mdash; you can
          restore them anytime from the Archived coaches list with their
          information intact.
        </p>
      </div>
      <div className="px-5 py-4 flex items-center justify-between gap-4">
        <p className="text-xs text-fg-muted">
          {isAdmin
            ? "Admins can't be archived from this screen."
            : "Type the coach's name on the next screen to confirm."}
        </p>
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={isAdmin}
          title={
            isAdmin
              ? "Admin accounts can't be archived via this surface"
              : undefined
          }
          className="inline-flex items-center gap-1.5 rounded-lg border border-danger/40 bg-danger/10 text-danger hover:bg-danger/20 hover:border-danger/60 shadow-[var(--shadow-sm)] h-9 px-3 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 transition-colors"
        >
          <Archive className="h-3.5 w-3.5" />
          Archive coach
        </button>
      </div>

      <ConfirmDialog
        open={open}
        onOpenChange={handleOpenChange}
        title="Archive this coach?"
        description={
          <>
            <p>
              This removes them from active surfaces but keeps their name,
              email, and past billing intact. You can restore them anytime
              from the Archived coaches list.
            </p>
            {error ? (
              <p role="alert" className="mt-2 text-danger">
                {error}
              </p>
            ) : null}
          </>
        }
        typedConfirmation={{ phrase: expected }}
        confirmLabel={pending ? "Archiving…" : "Archive coach"}
        onConfirm={handleConfirm}
        isPending={pending}
      />
    </div>
  );
}
