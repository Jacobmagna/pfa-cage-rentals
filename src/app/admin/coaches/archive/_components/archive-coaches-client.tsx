"use client";

import { useState, useTransition } from "react";
import { ArchiveRestore } from "lucide-react";
import { restoreCoach } from "../../actions";
import { ConfirmDialog } from "@/app/_components/confirm-dialog";
import { PFA_TIMEZONE } from "@/lib/timezone";

export type ArchivedCoachRow = {
  id: string;
  name: string | null;
  email: string;
  archivedAt: Date;
};

// Client island for the archived-coaches view (#28). Mirrors the athlete
// archive-client's Restore flow, but coaches are restored ONE AT A TIME
// from this table (coaches are archived one-at-a-time from the detail
// page's danger zone — no bulk select on this surface, matching that
// placement). Each row's Restore opens a confirm dialog → restoreCoach
// clears users.deletedAt and the coach returns to the active list.
//
// Archiving (#28) is a reversible soft-delete that PRESERVES identity, so
// rows here show the coach's real name + email and Restore is a lossless
// round-trip — they come back exactly as they were. (The heavier J9
// anonymizing delete is a separate privacy-erasure path, not this one.)
export function ArchiveCoachesClient({
  coaches,
}: {
  coaches: ArchivedCoachRow[];
}) {
  const [target, setTarget] = useState<ArchivedCoachRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRestoring, startTransition] = useTransition();

  const handleConfirm = () => {
    if (!target) return;
    setError(null);
    const id = target.id;
    startTransition(async () => {
      try {
        await restoreCoach(id);
        setTarget(null);
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
    <>
      <div className="overflow-x-auto rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)]">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="border-b border-line text-[11px] font-semibold uppercase tracking-wider text-fg-muted bg-surface-2/50">
            <tr>
              <th scope="col" className="px-4 py-3 text-left font-semibold">
                Coach
              </th>
              <th scope="col" className="px-4 py-3 text-left font-semibold">
                Email
              </th>
              <th scope="col" className="px-4 py-3 text-left font-semibold">
                Archived
              </th>
              <th
                scope="col"
                className="px-4 py-3 text-right font-semibold sr-only"
              >
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {coaches.map((row) => (
              <tr
                key={row.id}
                className="border-t border-line transition-colors last:border-b-0 hover:bg-surface-2"
              >
                <td className="px-4 py-3">
                  <div className="min-w-0 max-w-[16rem]">
                    <span
                      className="block truncate font-medium text-fg"
                      title={row.name ?? row.email}
                    >
                      {row.name ?? row.email}
                    </span>
                  </div>
                </td>
                <td className="px-4 py-3 text-xs text-fg-muted">
                  <span
                    className="block max-w-[18rem] truncate"
                    title={row.email}
                  >
                    {row.email}
                  </span>
                </td>
                <td className="px-4 py-3 font-mono tnum tabular-nums text-xs text-fg-muted whitespace-nowrap">
                  {formatArchived(row.archivedAt)}
                </td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  <button
                    type="button"
                    onClick={() => {
                      setError(null);
                      setTarget(row);
                    }}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 text-xs font-medium text-fg-muted transition hover:-translate-y-px hover:text-fg shadow-[var(--shadow-sm)] hover:shadow-[var(--shadow-md)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
                  >
                    <ArchiveRestore className="h-3.5 w-3.5" />
                    Restore
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={target !== null}
        onOpenChange={(next) => {
          if (!next && !isRestoring) {
            setTarget(null);
            setError(null);
          }
        }}
        variant="default"
        title="Restore this coach?"
        description={
          <>
            <p>
              They return to the active Coaches list with their name and
              email intact, and can sign back in.
            </p>
            {error ? (
              <p role="alert" className="mt-2 font-medium text-danger">
                {error}
              </p>
            ) : null}
          </>
        }
        confirmLabel={isRestoring ? "Restoring…" : "Restore coach"}
        onConfirm={handleConfirm}
        isPending={isRestoring}
      />
    </>
  );
}

function formatArchived(d: Date): string {
  return d.toLocaleDateString("en-US", {
    timeZone: PFA_TIMEZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
