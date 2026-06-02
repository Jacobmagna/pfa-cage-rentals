"use client";

import { useMemo, useState, useTransition } from "react";
import { ArchiveRestore } from "lucide-react";
import { restoreAthletesAction } from "../form-actions";
import { ConfirmDialog } from "@/app/_components/confirm-dialog";

export type ProgramOption = {
  id: string;
  name: string;
};

export type ArchivedAthleteRow = {
  id: string;
  firstName: string;
  lastName: string;
  birthday: string | null;
  term: string | null;
  programs: ProgramOption[];
};

// Client island for the Archive sub-tab (DEC-28). Mirrors roster-client
// (checkbox select-all/one, First, Last, Birthday, Term, Programs) but
// restore-only — no add / edit / delete. Selecting rows reveals a bulk
// Restore action that flips archivedAt back to null and returns the
// athletes to the active roster. Vanilla <table>, no shadcn (DEC-07).
export function ArchiveClient({
  athletes,
}: {
  athletes: ArchivedAthleteRow[];
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [isRestoring, startTransition] = useTransition();

  // Drop selected ids that vanished after a revalidation (e.g. restored).
  const selectedIds = useMemo(() => {
    const present = new Set(athletes.map((a) => a.id));
    return [...selected].filter((id) => present.has(id));
  }, [selected, athletes]);

  const allSelected =
    athletes.length > 0 && selectedIds.length === athletes.length;

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(athletes.map((a) => a.id)));
  };

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearSelection = () => setSelected(new Set());

  const handleConfirmRestore = () => {
    if (selectedIds.length === 0) return;
    setRestoreError(null);
    startTransition(async () => {
      const result = await restoreAthletesAction(selectedIds);
      if (result.ok) {
        setRestoreOpen(false);
        clearSelection();
      } else {
        setRestoreError(result.error.message);
      }
    });
  };

  return (
    <>
      {selectedIds.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-gold/40 bg-gold/10 px-4 py-2.5">
          <p className="text-sm text-fg">{selectedIds.length} selected</p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={clearSelection}
              className="h-8 rounded-md px-3 text-sm font-medium text-fg-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={() => {
                setRestoreError(null);
                setRestoreOpen(true);
              }}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-gold px-3 text-sm font-semibold text-gold-ink transition-colors hover:bg-gold-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
            >
              <ArchiveRestore className="h-3.5 w-3.5" />
              Restore
            </button>
          </div>
        </div>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="border-b border-line text-[11px] uppercase tracking-[0.14em] text-fg-subtle">
            <tr>
              <th scope="col" className="px-4 py-3 text-left font-medium">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  aria-label="Select all archived athletes"
                  className="h-4 w-4 accent-gold"
                />
              </th>
              <th scope="col" className="px-4 py-3 text-left font-medium">
                First
              </th>
              <th scope="col" className="px-4 py-3 text-left font-medium">
                Last
              </th>
              <th scope="col" className="px-4 py-3 text-left font-medium">
                Birthday
              </th>
              <th scope="col" className="px-4 py-3 text-left font-medium">
                Term
              </th>
              <th scope="col" className="px-4 py-3 text-left font-medium">
                Programs
              </th>
            </tr>
          </thead>
          <tbody>
            {athletes.map((row) => {
              const isSelected = selectedIds.includes(row.id);
              return (
                <tr
                  key={row.id}
                  className="border-b border-line/50 transition-colors last:border-b-0 hover:bg-surface/60"
                >
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleOne(row.id)}
                      aria-label={`Select ${row.firstName} ${row.lastName}`}
                      className="h-4 w-4 accent-gold"
                    />
                  </td>
                  <td className="px-4 py-3 text-fg">{row.firstName}</td>
                  <td className="px-4 py-3 text-fg">{row.lastName}</td>
                  <td className="px-4 py-3 font-mono tabular-nums text-xs text-fg-muted whitespace-nowrap">
                    {row.birthday ? formatBirthday(row.birthday) : "—"}
                  </td>
                  <td className="px-4 py-3 text-fg-muted whitespace-nowrap">
                    {row.term ?? "—"}
                  </td>
                  <td className="px-4 py-3">
                    {row.programs.length === 0 ? (
                      <span className="text-fg-subtle">—</span>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {row.programs.map((p) => (
                          <span
                            key={p.id}
                            className="inline-flex items-center rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-fg-muted ring-1 ring-inset ring-line"
                          >
                            {p.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={restoreOpen}
        onOpenChange={(next) => {
          if (!next && !isRestoring) {
            setRestoreOpen(false);
            setRestoreError(null);
          }
        }}
        variant="default"
        title={`Restore ${selectedIds.length} athlete${
          selectedIds.length === 1 ? "" : "s"
        }?`}
        description={
          <>
            They return to the active roster.
            {restoreError ? (
              <span className="mt-2 block font-medium text-danger">
                {restoreError}
              </span>
            ) : null}
          </>
        }
        confirmLabel={isRestoring ? "Restoring…" : "Restore"}
        onConfirm={handleConfirmRestore}
        isPending={isRestoring}
      />
    </>
  );
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

// "May 24, 2010" from a "YYYY-MM-DD" calendar string. Birthday is a pure
// calendar date with no timezone, so we format the parts directly — no
// Date/timezone conversion that could shift the displayed day.
function formatBirthday(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d || m < 1 || m > 12) return iso;
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}
