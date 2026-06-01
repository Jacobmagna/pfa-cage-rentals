"use client";

import { useState, useTransition } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { HourEditDialog, type HourEditInitialValues } from "./hour-edit-dialog";
import { deleteHourAction } from "../form-actions";
import { PFA_TIMEZONE } from "@/lib/timezone";
import { ConfirmDialog } from "@/app/_components/confirm-dialog";

// Top-level client island for the admin hour-log page. Owns the edit
// dialog open/close state, the row delete pending state, and renders
// the table. Mirrors admin/sessions/_components/sessions-client.tsx.

export type HourRow = {
  id: string;
  coachId: string;
  coachName: string | null;
  coachEmail: string;
  programName: string;
  startAt: Date;
  endAt: Date;
  note: string | null;
};

export type ProgramOption = {
  id: string;
  name: string;
};

export function HoursClient({
  rows,
  programOptions,
}: {
  rows: HourRow[];
  programOptions: ProgramOption[];
}) {
  const [editRow, setEditRow] = useState<HourRow | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [confirmRow, setConfirmRow] = useState<HourRow | null>(null);
  const [isDeleting, startTransition] = useTransition();

  const handleConfirmDelete = () => {
    const row = confirmRow;
    if (!row) return;
    setPendingDeleteId(row.id);
    startTransition(async () => {
      try {
        await deleteHourAction(row.id);
        setConfirmRow(null);
      } finally {
        setPendingDeleteId(null);
      }
    });
  };

  const initialValues: HourEditInitialValues | undefined = editRow
    ? {
        id: editRow.id,
        programId: "", // resolved from program name below
        programName: editRow.programName,
        startAt: editRow.startAt,
        endAt: editRow.endAt,
        note: editRow.note,
      }
    : undefined;

  // The edit dialog edits times + note only; the program stays bound to
  // the row. We pass the program id through so editHourLogSchema parses
  // — resolve it from the program option list by name (the row carries
  // the name, not the id, since the workbook fetch joins on name).
  const resolvedInitial: HourEditInitialValues | undefined = initialValues
    ? {
        ...initialValues,
        programId:
          programOptions.find((p) => p.name === initialValues.programName)?.id ??
          "",
      }
    : undefined;

  return (
    <>
      <div className="mb-4">
        <p className="text-xs uppercase tracking-[0.14em] text-fg-subtle">
          {rows.length} {rows.length === 1 ? "entry" : "entries"}
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-line/60 bg-surface/40 p-12 text-center">
          <p className="text-sm text-fg-muted">
            No logged hours match these filters. Try widening the date range or
            clearing some filters.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px]">
            <thead className="text-[11px] uppercase tracking-[0.14em] text-fg-subtle border-b border-line">
              <tr>
                <th scope="col" className="px-4 py-3 text-left font-medium">Coach</th>
                <th scope="col" className="px-4 py-3 text-left font-medium">Program</th>
                <th scope="col" className="px-4 py-3 text-left font-medium">Date</th>
                <th scope="col" className="px-4 py-3 text-left font-medium">Start</th>
                <th scope="col" className="px-4 py-3 text-left font-medium">End</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">Hours</th>
                <th scope="col" className="px-4 py-3 text-left font-medium">Note</th>
                <th scope="col" className="px-4 py-3 text-right font-medium sr-only">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const isPendingDelete = pendingDeleteId === row.id;
                return (
                  <tr
                    key={row.id}
                    className={`border-b border-line/50 last:border-b-0 hover:bg-surface/60 transition-colors ${
                      isPendingDelete ? "opacity-50" : ""
                    }`}
                  >
                    <td className="px-4 py-3 text-sm text-fg">
                      {row.coachName ?? row.coachEmail}
                    </td>
                    <td className="px-4 py-3 text-sm text-fg-muted">
                      {row.programName}
                    </td>
                    <td className="px-4 py-3 text-sm font-mono tabular-nums whitespace-nowrap">
                      {formatDate(row.startAt)}
                    </td>
                    <td className="px-4 py-3 text-sm font-mono tabular-nums whitespace-nowrap">
                      {formatTime(row.startAt)}
                    </td>
                    <td className="px-4 py-3 text-sm font-mono tabular-nums whitespace-nowrap">
                      {formatTime(row.endAt)}
                    </td>
                    <td className="px-4 py-3 text-sm font-mono tabular-nums text-right text-fg-muted whitespace-nowrap">
                      {formatHours(row.startAt, row.endAt)}
                    </td>
                    <td className="px-4 py-3 text-sm text-fg-subtle">
                      {row.note ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setEditRow(row)}
                          disabled={isPendingDelete}
                          className="inline-flex items-center justify-center h-10 w-10 sm:h-8 sm:w-8 rounded-md text-fg-muted hover:text-fg hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors disabled:opacity-40"
                          aria-label="Edit hour log"
                          title="Edit"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmRow(row)}
                          disabled={isPendingDelete}
                          className="inline-flex items-center justify-center h-10 w-10 sm:h-8 sm:w-8 rounded-md text-fg-muted hover:text-danger hover:bg-danger/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 transition-colors disabled:opacity-40"
                          aria-label="Delete hour log"
                          title="Delete"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <HourEditDialog
        open={editRow !== null}
        onClose={() => setEditRow(null)}
        initial={resolvedInitial}
      />

      <ConfirmDialog
        open={confirmRow !== null}
        onOpenChange={(next) => {
          if (!next) setConfirmRow(null);
        }}
        title="Delete this hour log?"
        description={
          confirmRow
            ? `${confirmRow.coachName ?? confirmRow.coachEmail} · ${confirmRow.programName} · ${formatDate(confirmRow.startAt)} ${formatTime(confirmRow.startAt)}–${formatTime(confirmRow.endAt)}. This can't be undone.`
            : undefined
        }
        confirmLabel={isDeleting ? "Deleting…" : "Delete entry"}
        onConfirm={handleConfirmDelete}
        isPending={isDeleting}
      />
    </>
  );
}

// "Mon May 24" in PFA TZ — same wall clock for every viewer.
function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    timeZone: PFA_TIMEZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString("en-US", {
    timeZone: PFA_TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatHours(start: Date, end: Date): string {
  const hours = (end.getTime() - start.getTime()) / 3_600_000;
  return (Math.round(hours * 100) / 100).toFixed(2);
}
