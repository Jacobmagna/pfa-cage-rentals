"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { ChevronLeft, ChevronRight, Pencil, Plus, Trash2 } from "lucide-react";
import { deleteOwnSessionAction } from "../form-actions";
import { PFA_TIMEZONE } from "@/lib/timezone";
import {
  EditSessionDialog,
  type SessionInitial,
} from "./edit-session-dialog";
import { HistoryFilters } from "./history-filters";
import type { ResourceOption } from "./types";
import { buildHistoryQuery, type HistoryFilters as HistoryFilterSet } from "../filters.logic";
import { ConfirmDialog } from "@/app/_components/confirm-dialog";

// Renders the history list, owns the edit-dialog open/close + the
// row delete pending state. Pagination links are server-side and
// PRESERVE the active filters (built via buildHistoryQuery) so the
// URL is shareable; we just style the prev/next affordances.

export type HistoryRow = {
  id: string;
  resourceId: string;
  resourceName: string;
  resourceType: "cage" | "bullpen" | "weight_room";
  startAt: Date;
  endAt: Date;
  note: string | null;
};

export function SessionsHistoryClient({
  rows,
  resources,
  page,
  totalPages,
  totalCount,
  filters,
}: {
  rows: HistoryRow[];
  resources: ResourceOption[];
  page: number;
  totalPages: number;
  totalCount: number;
  filters: HistoryFilterSet;
}) {
  const [editingRow, setEditingRow] = useState<HistoryRow | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [confirmRow, setConfirmRow] = useState<HistoryRow | null>(null);
  const [isDeleting, startTransition] = useTransition();

  const onDelete = (row: HistoryRow) => {
    setConfirmRow(row);
  };

  const handleConfirmDelete = () => {
    const row = confirmRow;
    if (!row) return;
    setPendingDeleteId(row.id);
    startTransition(async () => {
      try {
        await deleteOwnSessionAction(row.id);
        setConfirmRow(null);
      } finally {
        setPendingDeleteId(null);
      }
    });
  };

  const initialForDialog: SessionInitial | null = editingRow
    ? {
        id: editingRow.id,
        resourceId: editingRow.resourceId,
        startAt: editingRow.startAt,
        endAt: editingRow.endAt,
        note: editingRow.note,
      }
    : null;

  return (
    <>
      <div className="mb-5 flex items-center justify-between gap-3">
        <p className="text-xs uppercase tracking-[0.14em] text-fg-subtle">
          {totalCount} {totalCount === 1 ? "rental" : "rentals"}
        </p>
        <Link
          href="/coach/sessions/new"
          className="inline-flex items-center gap-1.5 rounded-lg bg-gold shadow-[var(--shadow-sm)] px-4 h-9 text-sm font-medium text-gold-ink hover:bg-gold-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
        >
          <Plus className="h-4 w-4" strokeWidth={2.5} />
          Log rental
        </Link>
      </div>

      <HistoryFilters
        resources={resources}
        values={{
          from: filters.from,
          to: filters.to,
          resourceId: filters.resourceId,
        }}
        isFiltered={filters.isFiltered}
      />

      {rows.length === 0 ? (
        <div className="rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)] p-8 text-center">
          <p className="text-sm text-fg-muted">
            No rentals match these filters.
          </p>
          <Link
            href="/coach/sessions"
            className="mt-3 inline-flex items-center justify-center rounded-lg border border-line bg-surface-2 px-4 h-9 text-sm font-medium text-fg hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
          >
            Clear filters
          </Link>
        </div>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)] overflow-hidden">
          {rows.map((row) => {
            const isPendingDelete = pendingDeleteId === row.id;
            return (
              <li
                key={row.id}
                className={`flex items-center gap-3 px-3.5 py-2.5 transition hover:bg-surface-2 ${
                  isPendingDelete ? "opacity-50" : ""
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="text-xs font-medium uppercase tracking-wider text-fg-muted whitespace-nowrap">
                      {formatDate(row.startAt)}
                    </span>
                    <span className="text-sm font-medium tabular-nums text-fg whitespace-nowrap">
                      {formatTimeRange(row.startAt, row.endAt)}
                    </span>
                    <span className="text-sm text-fg-muted truncate">
                      {row.resourceName}
                    </span>
                  </div>
                  {row.note ? (
                    <p
                      className="mt-0.5 text-xs text-fg-subtle leading-snug truncate"
                      title={row.note}
                    >
                      {row.note}
                    </p>
                  ) : null}
                </div>

                <span className="text-xs font-mono tabular-nums text-fg-muted whitespace-nowrap">
                  {formatDuration(row.startAt, row.endAt)}
                </span>

                <div className="flex items-center gap-0.5 whitespace-nowrap">
                  <button
                    type="button"
                    onClick={() => setEditingRow(row)}
                    disabled={isPendingDelete}
                    className="inline-flex items-center justify-center h-9 w-9 sm:h-8 sm:w-8 rounded-md text-fg-muted hover:text-fg hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors disabled:opacity-40"
                    aria-label="Edit rental"
                    title="Edit"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(row)}
                    disabled={isPendingDelete}
                    className="inline-flex items-center justify-center h-9 w-9 sm:h-8 sm:w-8 rounded-md text-fg-muted hover:text-danger hover:bg-danger/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 transition-colors disabled:opacity-40"
                    aria-label="Delete rental"
                    title="Delete"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {totalPages > 1 ? (
        <nav
          className="mt-6 flex items-center justify-between text-xs text-fg-muted"
          aria-label="Pagination"
        >
          <PaginationLink
            href={
              page > 1
                ? buildHistoryQuery({ ...filters, page: page - 1 })
                : null
            }
            label="Previous"
            icon="left"
          />
          <span className="tabular-nums">
            Page {page} of {totalPages}
          </span>
          <PaginationLink
            href={
              page < totalPages
                ? buildHistoryQuery({ ...filters, page: page + 1 })
                : null
            }
            label="Next"
            icon="right"
          />
        </nav>
      ) : null}

      <EditSessionDialog
        open={editingRow !== null}
        onClose={() => setEditingRow(null)}
        resources={resources}
        initial={initialForDialog}
      />

      <ConfirmDialog
        open={confirmRow !== null}
        onOpenChange={(next) => {
          if (!next) setConfirmRow(null);
        }}
        title="Delete this rental?"
        description={
          confirmRow
            ? `${confirmRow.resourceName} · ${formatWhen(confirmRow.startAt, confirmRow.endAt)}. This can't be undone.`
            : undefined
        }
        confirmLabel={isDeleting ? "Deleting…" : "Delete rental"}
        onConfirm={handleConfirmDelete}
        isPending={isDeleting}
      />
    </>
  );
}

function PaginationLink({
  href,
  label,
  icon,
}: {
  href: string | null;
  label: string;
  icon: "left" | "right";
}) {
  const className =
    "inline-flex items-center gap-1 px-2 h-8 rounded-md transition-colors";
  const enabled =
    "border border-line hover:border-line-strong hover:bg-surface-2 text-fg";
  const disabled = "text-fg-subtle opacity-40 pointer-events-none";
  const content =
    icon === "left" ? (
      <>
        <ChevronLeft className="h-3.5 w-3.5" />
        {label}
      </>
    ) : (
      <>
        {label}
        <ChevronRight className="h-3.5 w-3.5" />
      </>
    );
  if (!href) {
    return <span className={`${className} ${disabled}`}>{content}</span>;
  }
  return (
    <Link href={href} className={`${className} ${enabled}`}>
      {content}
    </Link>
  );
}

function formatWhen(start: Date, end: Date): string {
  return `${formatDate(start)} · ${formatTimeRange(start, end)}`;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    timeZone: PFA_TIMEZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function formatTimeRange(start: Date, end: Date): string {
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
  return `${startTime} – ${endTime}`;
}

function formatDuration(start: Date, end: Date): string {
  const minutes = Math.round((end.getTime() - start.getTime()) / 60_000);
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return `${mins} min`;
  if (mins === 0) return `${hours} hr`;
  return `${hours} hr ${mins} min`;
}
