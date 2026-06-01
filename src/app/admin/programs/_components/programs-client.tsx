"use client";

import { useState, useTransition } from "react";
import { Pencil, RotateCcw, Users } from "lucide-react";
import {
  deactivateProgramAction,
  reactivateProgramAction,
} from "../form-actions";
import {
  ProgramFormDialog,
  type ProgramEditInitialValues,
} from "./program-form-dialog";
import {
  ProgramCoachesDialog,
  type CoachOption,
} from "./program-coaches-dialog";
import { ConfirmDialog } from "@/app/_components/confirm-dialog";

export type ProgramRow = {
  id: string;
  name: string;
  cap: number | null;
  capPeriod: "week" | "month" | null;
  active: boolean;
  coaches: { id: string; name: string }[];
};

// Top-level client island for the programs page. Owns the edit-dialog,
// coaches-dialog, and deactivate-confirm open state, plus per-row pending
// state for the direct (reactivate) and confirmed (deactivate) actions.
// Renders a vanilla <table>. Mirrors admin/hour-log's HoursClient +
// roster's RosterClient.
export function ProgramsClient({
  programs,
  coachOptions,
}: {
  programs: ProgramRow[];
  coachOptions: CoachOption[];
}) {
  const [editRow, setEditRow] = useState<ProgramRow | null>(null);
  const [coachesRow, setCoachesRow] = useState<ProgramRow | null>(null);
  const [confirmRow, setConfirmRow] = useState<ProgramRow | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleConfirmDeactivate = () => {
    const row = confirmRow;
    if (!row) return;
    setPendingId(row.id);
    startTransition(async () => {
      try {
        await deactivateProgramAction(row.id);
        setConfirmRow(null);
      } finally {
        setPendingId(null);
      }
    });
  };

  const handleReactivate = (row: ProgramRow) => {
    setPendingId(row.id);
    startTransition(async () => {
      try {
        await reactivateProgramAction(row.id);
      } finally {
        setPendingId(null);
      }
    });
  };

  const editInitial: ProgramEditInitialValues | undefined = editRow
    ? {
        id: editRow.id,
        name: editRow.name,
        cap: editRow.cap,
        capPeriod: editRow.capPeriod,
      }
    : undefined;

  return (
    <>
      {programs.length === 0 ? (
        <div className="rounded-lg border border-line/60 bg-surface/40 p-12 text-center">
          <p className="text-sm text-fg-muted">
            No programs yet. Add your first program above.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px]">
            <thead className="text-[11px] uppercase tracking-[0.14em] text-fg-subtle border-b border-line">
              <tr>
                <th scope="col" className="px-4 py-3 text-left font-medium">
                  Program
                </th>
                <th scope="col" className="px-4 py-3 text-left font-medium">
                  Cap
                </th>
                <th scope="col" className="px-4 py-3 text-left font-medium">
                  Coaches
                </th>
                <th scope="col" className="px-4 py-3 text-left font-medium">
                  Status
                </th>
                <th
                  scope="col"
                  className="px-4 py-3 text-right font-medium sr-only"
                >
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {programs.map((row) => {
                const rowPending = pendingId === row.id;
                return (
                  <tr
                    key={row.id}
                    className={`border-b border-line/50 last:border-b-0 hover:bg-surface/60 transition-colors ${
                      rowPending ? "opacity-50" : ""
                    } ${row.active ? "" : "text-fg-muted"}`}
                  >
                    <td className="px-4 py-3 text-sm font-medium text-fg">
                      {row.name}
                    </td>
                    <td className="px-4 py-3 text-sm text-fg-muted whitespace-nowrap">
                      {row.cap !== null && row.capPeriod !== null
                        ? `${row.cap} / ${row.capPeriod}`
                        : "No cap"}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {row.coaches.length === 0 ? (
                        <span className="text-fg-subtle">—</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {row.coaches.map((c) => (
                            <span
                              key={c.id}
                              className="inline-flex items-center rounded-full border border-line bg-surface-2 px-2 py-0.5 text-xs text-fg-muted"
                            >
                              {c.name}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm whitespace-nowrap">
                      {row.active ? (
                        <span className="inline-flex items-center gap-1.5 text-xs text-gold">
                          <span className="h-1.5 w-1.5 rounded-full bg-gold" />
                          Active
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-xs text-fg-subtle">
                          <span className="h-1.5 w-1.5 rounded-full bg-fg-subtle" />
                          Inactive
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setEditRow(row)}
                          disabled={rowPending}
                          className="inline-flex items-center justify-center h-10 w-10 sm:h-8 sm:w-8 rounded-md text-fg-muted hover:text-fg hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors disabled:opacity-40"
                          aria-label={`Edit ${row.name}`}
                          title="Edit"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setCoachesRow(row)}
                          disabled={rowPending}
                          className="inline-flex items-center justify-center h-10 w-10 sm:h-8 sm:w-8 rounded-md text-fg-muted hover:text-fg hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors disabled:opacity-40"
                          aria-label={`Assign coaches for ${row.name}`}
                          title="Coaches"
                        >
                          <Users className="h-4 w-4" />
                        </button>
                        {row.active ? (
                          <button
                            type="button"
                            onClick={() => setConfirmRow(row)}
                            disabled={rowPending}
                            className="inline-flex items-center justify-center h-10 px-3 sm:h-8 rounded-md text-xs font-medium text-fg-muted hover:text-danger hover:bg-danger/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 transition-colors disabled:opacity-40"
                            title="Deactivate"
                          >
                            Deactivate
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleReactivate(row)}
                            disabled={rowPending}
                            className="inline-flex items-center gap-1.5 h-10 px-3 sm:h-8 rounded-md text-xs font-medium text-fg-muted hover:text-fg hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors disabled:opacity-40"
                            title="Reactivate"
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                            Reactivate
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <ProgramFormDialog
        open={editRow !== null}
        onClose={() => setEditRow(null)}
        initial={editInitial}
      />

      <ProgramCoachesDialog
        open={coachesRow !== null}
        onClose={() => setCoachesRow(null)}
        programId={coachesRow?.id ?? null}
        programName={coachesRow?.name ?? null}
        coachOptions={coachOptions}
        currentCoachIds={coachesRow?.coaches.map((c) => c.id) ?? []}
      />

      <ConfirmDialog
        open={confirmRow !== null}
        onOpenChange={(next) => {
          if (!next) setConfirmRow(null);
        }}
        title={
          confirmRow ? `Deactivate ${confirmRow.name}?` : "Deactivate program?"
        }
        description="It'll be hidden from new logs/attendance but history is kept."
        confirmLabel={isPending ? "Deactivating…" : "Deactivate"}
        onConfirm={handleConfirmDeactivate}
        isPending={isPending}
      />
    </>
  );
}
