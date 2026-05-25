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
import { AlertTriangle, Loader2, Trash2 } from "lucide-react";
import { deleteCoach } from "../actions";

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
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // What the user has to type to confirm. Name when present (matches
  // what they see in the page header); falls back to email otherwise.
  const expected = (coachName ?? coachEmail).trim();
  const typedMatches = typed.trim() === expected;

  const closeModal = () => {
    if (pending) return;
    setOpen(false);
    setTyped("");
    setError(null);
  };

  const handleConfirm = () => {
    if (!typedMatches) return;
    setError(null);
    startTransition(async () => {
      try {
        await deleteCoach(coachId);
        // After delete, route back to the list. The list re-renders
        // without this coach (revalidatePath already invalidated it).
        router.push("/admin/coaches");
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Couldn't delete this coach. Please try again.",
        );
      }
    });
  };

  return (
    <div className="mt-8 rounded-lg border border-danger/30 bg-danger/5 overflow-hidden">
      <div className="px-5 py-4 border-b border-danger/20 bg-danger/10">
        <p className="text-[10px] uppercase tracking-[0.18em] text-danger">
          Danger zone
        </p>
        <h3 className="mt-1 text-base font-semibold text-fg">
          Delete coach
        </h3>
        <p className="mt-1.5 text-xs text-fg-muted leading-relaxed">
          Anonymizes this coach&rsquo;s identity (name and email) and removes
          them from active lists. Past session and billing rows are kept for
          historical reports but no longer linked to a personal identity.
          The coach won&rsquo;t be able to sign back in. This action cannot
          be undone.
        </p>
      </div>
      <div className="px-5 py-4 flex items-center justify-between gap-4">
        <p className="text-xs text-fg-muted">
          {isAdmin
            ? "Admins can't be deleted from this screen."
            : "Type the coach's name on the next screen to confirm."}
        </p>
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={isAdmin}
          title={
            isAdmin
              ? "Admin accounts can't be deleted via this surface"
              : undefined
          }
          className="inline-flex items-center gap-1.5 rounded-md border border-danger/40 bg-danger/10 text-danger hover:bg-danger/20 hover:border-danger/60 h-9 px-3 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 transition-colors"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete coach
        </button>
      </div>

      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-coach-title"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
          onClick={closeModal}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-lg border border-line bg-surface shadow-xl"
          >
            <div className="px-5 py-4 border-b border-line flex items-start gap-3">
              <div className="flex-shrink-0 w-9 h-9 rounded-full bg-danger/10 flex items-center justify-center">
                <AlertTriangle className="h-4 w-4 text-danger" />
              </div>
              <div>
                <h4
                  id="delete-coach-title"
                  className="text-base font-semibold text-fg"
                >
                  Delete this coach?
                </h4>
                <p className="mt-1 text-xs text-fg-muted">
                  This anonymizes their identity and removes them from
                  active surfaces. Past billing stays in reports under
                  &ldquo;Former coach.&rdquo;
                </p>
              </div>
            </div>
            <div className="px-5 py-4 space-y-3">
              <label className="block">
                <span className="text-xs text-fg-muted">
                  Type{" "}
                  <span className="font-mono text-fg">{expected}</span> to
                  confirm
                </span>
                <input
                  type="text"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  autoFocus
                  disabled={pending}
                  className="mt-1.5 w-full px-3 h-10 rounded-md bg-page border border-line text-fg placeholder:text-fg-subtle text-sm focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-danger/40"
                  placeholder={expected}
                />
              </label>
              {error ? (
                <p role="alert" className="text-[11px] text-danger">
                  {error}
                </p>
              ) : null}
            </div>
            <div className="px-5 py-4 border-t border-line flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={closeModal}
                disabled={pending}
                className="inline-flex items-center justify-center rounded-md border border-line bg-surface text-fg hover:bg-surface-2 h-9 px-3 text-sm font-medium disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                disabled={!typedMatches || pending}
                className="inline-flex items-center justify-center gap-1.5 rounded-md bg-danger text-fg hover:opacity-90 h-9 px-3 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 transition-colors"
              >
                {pending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" />
                )}
                {pending ? "Deleting…" : "Delete coach"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
