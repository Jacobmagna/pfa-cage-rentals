"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { SessionFormDialog, type SessionFormInitialValues } from "./session-form-dialog";
import { deleteSessionAction } from "../form-actions";
import { PFA_TIMEZONE } from "@/lib/timezone";
import { ConfirmDialog } from "@/app/_components/confirm-dialog";
import { GroupPill } from "@/app/_components/group-pill";

// Top-level client island for the admin sessions page. Owns the
// dialog open/close state (create vs edit), the row delete pending
// state, and renders the table.
//
// Why one big client island rather than smaller ones: the dialog
// needs the coaches + resources lists, the table rows need them
// for editing too, and splitting would mean prop drilling or a
// React context for one page. For 50 rows + one dialog, this is
// fine.

export type SessionRow = {
  id: string;
  coachId: string;
  coachName: string | null;
  coachEmail: string;
  resourceId: string;
  resourceName: string;
  resourceType: "cage" | "bullpen" | "weight_room";
  startAt: Date;
  endAt: Date;
  note: string | null;
  ratePer30MinCents: number;
  // Weight-room rental billed at the group rate — drives the "Group" pill.
  isGroupSession: boolean;
};

export type CoachOption = {
  id: string;
  name: string | null;
  email: string;
};

export type ResourceOption = {
  id: string;
  name: string;
  type: "cage" | "bullpen" | "weight_room";
  sortOrder: number;
};

export function SessionsClient({
  rows,
  coachOptions,
  resourceOptions,
  truncated = false,
  maxRows,
}: {
  rows: SessionRow[];
  coachOptions: CoachOption[];
  resourceOptions: ResourceOption[];
  truncated?: boolean;
  maxRows?: number;
}) {
  const [dialogState, setDialogState] = useState<
    { mode: "closed" } | { mode: "create" } | { mode: "edit"; row: SessionRow }
  >({ mode: "closed" });
  const router = useRouter();
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [confirmRow, setConfirmRow] = useState<SessionRow | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isDeleting, startTransition] = useTransition();

  const openCreate = () => setDialogState({ mode: "create" });
  const openEdit = (row: SessionRow) => setDialogState({ mode: "edit", row });
  const close = () => setDialogState({ mode: "closed" });

  const onDelete = (row: SessionRow) => {
    setDeleteError(null);
    setConfirmRow(row);
  };

  const handleConfirmDelete = () => {
    const row = confirmRow;
    if (!row) return;
    setDeleteError(null);
    setPendingDeleteId(row.id);
    startTransition(async () => {
      try {
        await deleteSessionAction(row.id);
        setConfirmRow(null);
      } catch {
        // Benign "already gone" (another admin removed it, or a transient
        // blip). Don't throw to the route boundary — re-sync and tell the
        // user the stale row is on its way out.
        setDeleteError("That rental was already removed — refreshing.");
        router.refresh();
      } finally {
        setPendingDeleteId(null);
      }
    });
  };

  const initialValues: SessionFormInitialValues | undefined =
    dialogState.mode === "edit"
      ? {
          id: dialogState.row.id,
          coachId: dialogState.row.coachId,
          resourceId: dialogState.row.resourceId,
          startAt: dialogState.row.startAt,
          endAt: dialogState.row.endAt,
          note: dialogState.row.note,
          isGroupSession: dialogState.row.isGroupSession,
        }
      : undefined;

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-[11.5px] font-semibold uppercase tracking-[0.14em] text-fg-muted">
          <span className="tnum tabular-nums">{rows.length}</span>{" "}
          {rows.length === 1 ? "rental" : "rentals"}
          {truncated && maxRows ? (
            <span className="ml-2 normal-case tracking-normal text-fg-subtle">
              · showing first {maxRows}, narrow filters to see more
            </span>
          ) : null}
        </p>
        <button
          type="button"
          onClick={openCreate}
          className="inline-flex items-center gap-1.5 rounded-lg bg-gold px-4 h-9 text-sm font-medium text-gold-ink hover:bg-gold-hover shadow-[var(--shadow-sm)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
        >
          <Plus className="h-4 w-4" strokeWidth={2.5} />
          New rental
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)] p-12 text-center">
          <p className="text-sm text-fg-muted">
            No rentals match these filters. Try widening the date range or
            clearing some filters.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)]">
          <table className="w-full min-w-[640px]">
            <thead className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted border-b border-line bg-surface-2/50">
              <tr>
                <th scope="col" className="px-4 py-3 text-left font-semibold">When</th>
                <th scope="col" className="px-4 py-3 text-left font-semibold">Coach</th>
                <th scope="col" className="px-4 py-3 text-left font-semibold">Resource</th>
                <th scope="col" className="px-4 py-3 text-right font-semibold">Duration</th>
                <th scope="col" className="px-4 py-3 text-right font-semibold sr-only">
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
                    className={`border-t border-line hover:bg-surface-2 transition-colors ${
                      isPendingDelete ? "opacity-50" : ""
                    }`}
                  >
                    <td className="px-4 py-3 text-sm font-mono tnum tabular-nums whitespace-nowrap">
                      {formatWhen(row.startAt, row.endAt)}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <span className="inline-flex items-center gap-1.5 flex-wrap">
                        <span className="text-fg">
                          {row.coachName ?? row.coachEmail}
                        </span>
                      </span>
                      {row.note ? (
                        <span className="block text-xs text-fg-subtle mt-0.5">
                          {row.note}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-sm text-fg-muted">
                      <span className="inline-flex items-center gap-1.5 flex-wrap">
                        {row.resourceName}
                        {row.isGroupSession ? <GroupPill /> : null}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm font-mono tnum tabular-nums text-right text-fg-muted whitespace-nowrap">
                      {formatDuration(row.startAt, row.endAt)}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => openEdit(row)}
                          disabled={isPendingDelete}
                          className="inline-flex items-center justify-center h-10 w-10 sm:h-8 sm:w-8 rounded-lg text-fg-muted hover:text-fg hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors disabled:opacity-40"
                          aria-label="Edit rental"
                          title="Edit"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onDelete(row)}
                          disabled={isPendingDelete}
                          className="inline-flex items-center justify-center h-10 w-10 sm:h-8 sm:w-8 rounded-lg text-fg-muted hover:text-danger hover:bg-danger/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 transition-colors disabled:opacity-40"
                          aria-label="Delete rental"
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

      <SessionFormDialog
        open={dialogState.mode !== "closed"}
        mode={dialogState.mode === "edit" ? "edit" : "create"}
        onClose={close}
        coachOptions={coachOptions}
        resourceOptions={resourceOptions}
        initial={initialValues}
      />

      <ConfirmDialog
        open={confirmRow !== null}
        onOpenChange={(next) => {
          if (!next) {
            setConfirmRow(null);
            setDeleteError(null);
          }
        }}
        title="Delete this rental?"
        description={
          <>
            {confirmRow
              ? `${confirmRow.coachName ?? confirmRow.coachEmail} · ${confirmRow.resourceName} · ${formatWhen(confirmRow.startAt, confirmRow.endAt)}. This can't be undone.`
              : null}
            {deleteError ? (
              <span role="alert" className="mt-2 block text-danger">
                {deleteError}
              </span>
            ) : null}
          </>
        }
        confirmLabel={isDeleting ? "Deleting…" : "Delete rental"}
        onConfirm={handleConfirmDelete}
        isPending={isDeleting}
      />
    </>
  );
}

// Formats a session window as "Mon May 24 · 9:00 AM – 10:30 AM" in PFA TZ.
// Explicit timeZone: any user (in any browser TZ) sees the same wall-clock
// time, matching what was originally entered by the admin or coach.
function formatWhen(start: Date, end: Date): string {
  const date = start.toLocaleDateString("en-US", {
    timeZone: PFA_TIMEZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const startTime = start.toLocaleTimeString("en-US", {
    timeZone: PFA_TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
  });
  const endTime = end.toLocaleTimeString("en-US", {
    timeZone: PFA_TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
  });
  return `${date} · ${startTime} – ${endTime}`;
}

function formatDuration(start: Date, end: Date): string {
  const minutes = Math.round((end.getTime() - start.getTime()) / 60_000);
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return `${mins} min`;
  if (mins === 0) return `${hours} hr`;
  return `${hours} hr ${mins} min`;
}
