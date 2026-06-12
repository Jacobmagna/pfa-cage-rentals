"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Clock3,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import {
  deleteOwnSessionAction,
  requestOwnSessionRemovalAction,
} from "../form-actions";
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
  // 1b security: a PAST rental (startAt <= now) can't be deleted/edited-
  // billable by the coach — they request admin removal instead.
  isPast: boolean;
  // True when a PENDING removal request already exists for this rental.
  removalPending: boolean;
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
  const router = useRouter();
  const [editingRow, setEditingRow] = useState<HistoryRow | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [confirmRow, setConfirmRow] = useState<HistoryRow | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isDeleting, startTransition] = useTransition();
  const [removalRow, setRemovalRow] = useState<HistoryRow | null>(null);

  const onDelete = (row: HistoryRow) => {
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
        await deleteOwnSessionAction(row.id);
        setConfirmRow(null);
      } catch {
        // Benign "already gone" (admin removed it, or a transient blip).
        // Don't throw to the route boundary — re-sync and tell the user.
        setDeleteError("That rental was already removed — refreshing.");
        router.refresh();
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
                  {/* Edit stays available on every row — for PAST rentals the
                      dialog disables billable fields server-side & in-UI, so
                      only the note can change. */}
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
                  {row.isPast ? (
                    row.removalPending ? (
                      <span
                        className="inline-flex items-center gap-1 rounded-full border border-line-strong bg-surface-2 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-fg-muted"
                        title="An admin will review this removal request"
                      >
                        <Clock3 className="h-3 w-3" />
                        Removal requested
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setRemovalRow(row)}
                        className="inline-flex items-center justify-center h-9 w-9 sm:h-8 sm:w-8 rounded-md text-fg-muted hover:text-danger hover:bg-danger/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 transition-colors"
                        aria-label="Request removal"
                        title="Request removal"
                      >
                        <Clock3 className="h-4 w-4" />
                      </button>
                    )
                  ) : (
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
                  )}
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
        isPast={editingRow?.isPast ?? false}
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
              ? `${confirmRow.resourceName} · ${formatWhen(confirmRow.startAt, confirmRow.endAt)}. This can't be undone.`
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

      <RequestRemovalDialog
        row={removalRow}
        onClose={() => setRemovalRow(null)}
      />
    </>
  );
}

// 1b security: a coach can't delete a PAST rental directly — they ask an
// admin to remove it (it's money owed, so removal is admin-approved). This
// small dialog collects an optional "why it didn't happen" reason and files
// the request. Mirrors the ConfirmDialog chrome (default tone — this isn't
// the destructive action itself, just a request).
function RequestRemovalDialog({
  row,
  onClose,
}: {
  row: HistoryRow | null;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();
  const cancelRef = useRef<HTMLButtonElement>(null);

  const open = row !== null;

  // Reset the reason + focus Cancel each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReason("");
    const t = requestAnimationFrame(() => cancelRef.current?.focus());
    return () => cancelAnimationFrame(t);
  }, [open]);

  // ESC dismiss (unless mid-submit).
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pending) {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, pending, onClose]);

  if (!row) return null;

  const handleSubmit = () => {
    startTransition(async () => {
      await requestOwnSessionRemovalAction(row.id, reason.trim() || null);
      onClose();
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Request rental removal"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
      onClick={() => {
        if (!pending) onClose();
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl border border-line bg-surface shadow-[var(--shadow-lg)]"
      >
        <div className="px-5 py-4 border-b border-line">
          <h4 className="text-base font-semibold text-fg">
            Request removal of this rental?
          </h4>
          <p className="mt-1 text-xs text-fg-muted leading-relaxed">
            {row.resourceName} · {formatWhen(row.startAt, row.endAt)}. This
            rental has already started, so it can&apos;t be deleted directly —
            an admin will review your request.
          </p>
        </div>

        <div className="px-5 py-4">
          <label className="block">
            <span className="flex items-baseline justify-between mb-1.5">
              <span className="text-xs uppercase tracking-wider text-fg-muted">
                Reason
              </span>
              <span className="text-[10px] text-fg-subtle">optional</span>
            </span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={pending}
              rows={3}
              maxLength={500}
              placeholder="What happened? (e.g. the rental didn't happen)"
              className="w-full rounded-lg bg-page border border-line text-fg placeholder:text-fg-subtle px-3 py-2 text-sm focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40 resize-none"
            />
          </label>
        </div>

        <div className="px-5 py-4 border-t border-line flex items-center justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onClose}
            disabled={pending}
            className="inline-flex items-center justify-center rounded-lg border border-line-strong bg-surface text-fg-muted hover:text-fg hover:-translate-y-px h-9 px-3 text-sm font-medium shadow-[var(--shadow-sm)] hover:shadow-[var(--shadow-md)] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={pending}
            className="inline-flex items-center justify-center rounded-lg bg-gold text-gold-ink hover:bg-gold-hover shadow-[var(--shadow-sm)] h-9 px-3 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
          >
            {pending ? "Submitting…" : "Request removal"}
          </button>
        </div>
      </div>
    </div>
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
