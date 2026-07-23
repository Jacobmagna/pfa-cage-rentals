"use client";

import { useState, useTransition } from "react";
import { Pencil, RotateCcw } from "lucide-react";
import {
  deactivateProgramAction,
  reactivateProgramAction,
} from "../form-actions";
import {
  ProgramFormDialog,
  type ProgramEditInitialValues,
} from "./program-form-dialog";
import { ConfirmDialog } from "@/app/_components/confirm-dialog";

export type ProgramRow = {
  id: string;
  name: string;
  active: boolean;
  defaultRatePer30MinCents: number | null;
  // 0052 — pay mode + the flat per-session amount, so the edit dialog can
  // prefill the right field and the table can label how a program pays.
  payMode: "hourly" | "per_session";
  defaultPerSessionRateCents: number | null;
};

// Top-level client island for the programs page. Owns the edit-dialog
// and deactivate-confirm open state, plus per-row pending state for the
// direct (reactivate) and confirmed (deactivate) actions. Renders a
// vanilla <table>. Mirrors admin/hour-log's HoursClient + roster's
// RosterClient.
export function ProgramsClient({ programs }: { programs: ProgramRow[] }) {
  const [editRow, setEditRow] = useState<ProgramRow | null>(null);
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
        defaultRatePer30MinCents: editRow.defaultRatePer30MinCents,
        payMode: editRow.payMode,
        defaultPerSessionRateCents: editRow.defaultPerSessionRateCents,
      }
    : undefined;

  return (
    <>
      {programs.length === 0 ? (
        <div className="rounded-xl border border-line bg-surface p-12 text-center shadow-[var(--shadow-sm)]">
          <p className="text-sm text-fg-muted">
            No work types yet. Add your first above.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)]">
          <table className="w-full min-w-[720px]">
            <thead className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted border-b border-line">
              <tr>
                <th scope="col" className="px-4 py-3 text-left font-semibold">
                  Work
                </th>
                <th scope="col" className="px-4 py-3 text-left font-semibold">
                  Status
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
              {programs.map((row) => {
                const rowPending = pendingId === row.id;
                return (
                  <tr
                    key={row.id}
                    className={`border-t border-line last:border-b-0 hover:bg-surface-2 transition ${
                      rowPending ? "opacity-50" : ""
                    } ${row.active ? "" : "text-fg-muted"}`}
                  >
                    <td className="px-4 py-3 text-sm font-medium text-fg">
                      {row.name}
                    </td>
                    <td className="px-4 py-3 text-sm whitespace-nowrap">
                      {row.active ? (
                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-gold-strong">
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
                          className="inline-flex items-center justify-center h-10 w-10 sm:h-8 sm:w-8 rounded-md text-fg-muted hover:text-fg hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors disabled:opacity-40"
                          aria-label={`Edit ${row.name}`}
                          title="Edit"
                        >
                          <Pencil className="h-4 w-4" />
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
                            className="inline-flex items-center gap-1.5 h-10 px-3 sm:h-8 rounded-md text-xs font-medium text-fg-muted hover:text-fg hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors disabled:opacity-40"
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

      <ConfirmDialog
        open={confirmRow !== null}
        onOpenChange={(next) => {
          if (!next) setConfirmRow(null);
        }}
        title={
          confirmRow ? `Deactivate ${confirmRow.name}?` : "Deactivate work?"
        }
        description="It'll be hidden from new logs/attendance but history is kept."
        confirmLabel={isPending ? "Deactivating…" : "Deactivate"}
        onConfirm={handleConfirmDeactivate}
        isPending={isPending}
      />
    </>
  );
}
