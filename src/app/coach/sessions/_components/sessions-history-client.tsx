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
import type { ResourceOption } from "./types";

// Renders the history list, owns the edit-dialog open/close + the
// row delete pending state. Pagination links are server-side
// (?page=N) so the URL is shareable; we just style the prev/next
// affordances.

export type HistoryRow = {
  id: string;
  resourceId: string;
  resourceName: string;
  resourceType: "cage" | "bullpen" | "weight_room";
  startAt: Date;
  endAt: Date;
  useType: "hitting" | "pitching" | null;
  note: string | null;
  slots: number;
  ratePerSlotCents: number;
  totalCents: number;
};

export function SessionsHistoryClient({
  rows,
  resources,
  page,
  totalPages,
  totalCount,
}: {
  rows: HistoryRow[];
  resources: ResourceOption[];
  page: number;
  totalPages: number;
  totalCount: number;
}) {
  const [editingRow, setEditingRow] = useState<HistoryRow | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const onDelete = (row: HistoryRow) => {
    const when = formatWhen(row.startAt, row.endAt);
    if (
      !confirm(`Delete ${row.resourceName} session (${when})?\nThis can't be undone.`)
    ) {
      return;
    }
    setPendingDeleteId(row.id);
    startTransition(async () => {
      try {
        await deleteOwnSessionAction(row.id);
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
        useType: editingRow.useType,
        note: editingRow.note,
      }
    : null;

  return (
    <>
      <div className="mb-5 flex items-center justify-between gap-3">
        <p className="text-xs uppercase tracking-[0.14em] text-fg-subtle">
          {totalCount} {totalCount === 1 ? "session" : "sessions"}
        </p>
        <Link
          href="/coach/sessions/new"
          className="inline-flex items-center gap-1.5 rounded-md bg-gold px-4 h-9 text-sm font-medium text-gold-ink hover:bg-gold-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
        >
          <Plus className="h-4 w-4" strokeWidth={2.5} />
          Log session
        </Link>
      </div>

      <ul className="space-y-2.5">
        {rows.map((row) => {
          const isPendingDelete = pendingDeleteId === row.id;
          return (
            <li
              key={row.id}
              className={`rounded-lg border border-line bg-surface p-4 transition-opacity ${
                isPendingDelete ? "opacity-50" : ""
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-xs uppercase tracking-wider text-fg-muted">
                    {formatDate(row.startAt)}
                  </p>
                  <p className="mt-0.5 text-sm font-medium tabular-nums text-fg">
                    {formatTimeRange(row.startAt, row.endAt)}
                  </p>
                  <p className="mt-1.5 text-sm text-fg-muted">
                    {row.resourceName}
                    {row.useType ? (
                      <>
                        {" · "}
                        <span className="capitalize">{row.useType}</span>
                      </>
                    ) : null}
                  </p>
                  {row.note ? (
                    <p className="mt-1.5 text-xs text-fg-subtle leading-snug">
                      {row.note}
                    </p>
                  ) : null}
                </div>

                <div className="text-right whitespace-nowrap">
                  <p className="text-base font-semibold tabular-nums text-fg">
                    {formatCents(row.totalCents)}
                  </p>
                  <p className="mt-0.5 text-[11px] text-fg-subtle tabular-nums">
                    {row.slots} × {formatCents(row.ratePerSlotCents)}
                  </p>
                </div>
              </div>

              <div className="mt-3 flex items-center justify-end gap-1">
                <button
                  type="button"
                  onClick={() => setEditingRow(row)}
                  disabled={isPendingDelete}
                  className="inline-flex items-center justify-center h-8 w-8 rounded-md text-fg-muted hover:text-fg hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors disabled:opacity-40"
                  aria-label="Edit session"
                  title="Edit"
                >
                  <Pencil className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(row)}
                  disabled={isPendingDelete}
                  className="inline-flex items-center justify-center h-8 w-8 rounded-md text-fg-muted hover:text-danger hover:bg-danger/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 transition-colors disabled:opacity-40"
                  aria-label="Delete session"
                  title="Delete"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {totalPages > 1 ? (
        <nav
          className="mt-6 flex items-center justify-between text-xs text-fg-muted"
          aria-label="Pagination"
        >
          <PaginationLink
            href={page > 1 ? `/coach/sessions?page=${page - 1}` : null}
            label="Previous"
            icon="left"
          />
          <span className="tabular-nums">
            Page {page} of {totalPages}
          </span>
          <PaginationLink
            href={
              page < totalPages ? `/coach/sessions?page=${page + 1}` : null
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

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
