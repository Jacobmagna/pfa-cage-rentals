"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Pencil, Trash2, X } from "lucide-react";
import { HourEditDialog, type HourEditInitialValues } from "./hour-edit-dialog";
import { deleteHourAction } from "../form-actions";
import { acceptNeedsReviewLog, rejectNeedsReviewLog } from "../actions";
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
  programId: string;
  programName: string;
  startAt: Date;
  endAt: Date;
  note: string | null;
  scheduleNote: string | null;
  // QA10 W3-polish13a: true when no scheduled block the coach is a member of
  // overlaps this log (same program). reviewedAt set = admin acknowledged it.
  unscheduled: boolean;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  // 1b decision queue: posted = counts; held = pending approval; rejected =
  // decided no, won't count. decisionReason is the coach-visible reject note.
  status: "posted" | "held" | "rejected";
  decisionReason: string | null;
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
  const router = useRouter();
  const [editRow, setEditRow] = useState<HourRow | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [confirmRow, setConfirmRow] = useState<HourRow | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isDeleting, startTransition] = useTransition();
  const [unscheduledOnly, setUnscheduledOnly] = useState(false);
  const [pendingResolveId, setPendingResolveId] = useState<string | null>(null);
  const [, startResolveTransition] = useTransition();
  const [rejectRow, setRejectRow] = useState<HourRow | null>(null);

  const handleConfirmDelete = () => {
    const row = confirmRow;
    if (!row) return;
    setDeleteError(null);
    setPendingDeleteId(row.id);
    startTransition(async () => {
      try {
        await deleteHourAction(row.id);
        setConfirmRow(null);
      } catch {
        // Benign "already gone" (another admin removed it, or a transient
        // blip). Don't throw to the route boundary — re-sync and tell the
        // user the stale row is on its way out.
        setDeleteError("That entry was already removed — refreshing.");
        router.refresh();
      } finally {
        setPendingDeleteId(null);
      }
    });
  };

  const handleAccept = (row: HourRow) => {
    setPendingResolveId(row.id);
    startResolveTransition(async () => {
      try {
        await acceptNeedsReviewLog(row.id);
      } finally {
        setPendingResolveId(null);
      }
    });
  };

  const handleRejectConfirm = (row: HourRow, reason: string) => {
    setPendingResolveId(row.id);
    startResolveTransition(async () => {
      try {
        await rejectNeedsReviewLog(row.id, reason);
        setRejectRow(null);
      } finally {
        setPendingResolveId(null);
      }
    });
  };

  // Unscheduled-only triage matches exactly the rows that carry the red
  // "Unscheduled" badge — i.e. unscheduled and NOT already decided-rejected (a
  // rejected row shows a "Rejected" badge instead and drops out of triage).
  const visibleRows = unscheduledOnly
    ? rows.filter((r) => r.unscheduled && r.status !== "rejected")
    : rows;
  const unscheduledCount = rows.filter(
    (r) => r.unscheduled && r.status !== "rejected",
  ).length;

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
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs uppercase tracking-[0.14em] text-fg-subtle">
          {visibleRows.length}{" "}
          {visibleRows.length === 1 ? "entry" : "entries"}
        </p>
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface px-3 h-9 text-sm text-fg-muted shadow-[var(--shadow-sm)] transition hover:text-fg focus-within:ring-2 focus-within:ring-gold/40">
          <input
            type="checkbox"
            checked={unscheduledOnly}
            onChange={(e) => setUnscheduledOnly(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-line-strong text-gold accent-[var(--gold)] focus:outline-none"
          />
          Show unscheduled only
          {unscheduledCount > 0 ? (
            <span className="inline-flex items-center rounded-full border border-danger/30 bg-danger/10 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-danger">
              {unscheduledCount}
            </span>
          ) : null}
        </label>
      </div>

      {visibleRows.length === 0 ? (
        <div className="rounded-lg border border-line/60 bg-surface/40 p-12 text-center">
          <p className="text-sm text-fg-muted">
            {unscheduledOnly
              ? "No unscheduled logs need review in this window. Nice — everything lines up with the schedule."
              : "No logged hours match these filters. Try widening the date range or clearing some filters."}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)]">
          <table className="w-full min-w-[760px]">
            <thead className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted border-b border-line bg-surface-2/50">
              <tr>
                <th scope="col" className="px-4 py-3 text-left font-semibold">Coach</th>
                <th scope="col" className="px-4 py-3 text-left font-semibold">Program</th>
                <th scope="col" className="px-4 py-3 text-left font-semibold">Date</th>
                <th scope="col" className="px-4 py-3 text-left font-semibold">Start</th>
                <th scope="col" className="px-4 py-3 text-left font-semibold">End</th>
                <th scope="col" className="px-4 py-3 text-right font-semibold">Hours</th>
                <th scope="col" className="px-4 py-3 text-left font-semibold">Note</th>
                <th scope="col" className="px-4 py-3 text-left font-semibold">Schedule</th>
                <th scope="col" className="px-4 py-3 text-right font-semibold sr-only">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => {
                const isPendingDelete = pendingDeleteId === row.id;
                const isPendingResolve = pendingResolveId === row.id;
                return (
                  <tr
                    key={row.id}
                    className={`border-t border-line hover:bg-surface-2 transition-colors ${
                      isPendingDelete ? "opacity-50" : ""
                    }`}
                  >
                    <td className="px-4 py-3 text-sm text-fg">
                      {row.coachName ?? row.coachEmail}
                    </td>
                    <td className="px-4 py-3 text-sm text-fg-muted">
                      {row.programName}
                    </td>
                    <td className="px-4 py-3 text-sm font-mono tnum tabular-nums whitespace-nowrap">
                      {formatDate(row.startAt)}
                    </td>
                    <td className="px-4 py-3 text-sm font-mono tnum tabular-nums whitespace-nowrap">
                      {formatTime(row.startAt)}
                    </td>
                    <td className="px-4 py-3 text-sm font-mono tnum tabular-nums whitespace-nowrap">
                      {formatTime(row.endAt)}
                    </td>
                    <td className="px-4 py-3 text-sm font-mono tnum tabular-nums text-right text-fg-muted whitespace-nowrap">
                      {formatHours(row.startAt, row.endAt)}
                    </td>
                    <td className="px-4 py-3 text-sm text-fg-subtle">
                      {row.note ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <div className="flex flex-col items-start gap-1">
                        {row.status === "rejected" ? (
                          <span
                            className="inline-flex items-center rounded-full border border-danger/40 bg-danger/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-danger whitespace-nowrap"
                            title={row.decisionReason ?? undefined}
                          >
                            Rejected
                          </span>
                        ) : row.unscheduled ? (
                          <span className="inline-flex items-center rounded-full border border-danger/30 bg-danger/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-danger whitespace-nowrap">
                            Unscheduled
                          </span>
                        ) : null}
                        {row.status === "rejected" && row.decisionReason ? (
                          <span className="text-xs text-fg-subtle">
                            “{row.decisionReason}”
                          </span>
                        ) : row.scheduleNote ? (
                          <span className="text-danger">{row.scheduleNote}</span>
                        ) : row.status !== "rejected" && !row.unscheduled ? (
                          <span className="text-fg-subtle">—</span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1">
                        {row.unscheduled &&
                        !row.reviewedAt &&
                        row.status === "posted" ? (
                          <>
                            <button
                              type="button"
                              onClick={() => handleAccept(row)}
                              disabled={isPendingResolve}
                              className="inline-flex items-center gap-1 h-8 rounded-md border border-success/30 bg-success/10 px-2.5 text-xs font-medium text-success hover:bg-success/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-success/40 transition-colors disabled:opacity-40"
                              title="Accept — keep this hour posted and counting"
                            >
                              <Check className="h-3.5 w-3.5" />
                              {isPendingResolve ? "Saving…" : "Accept"}
                            </button>
                            <button
                              type="button"
                              onClick={() => setRejectRow(row)}
                              disabled={isPendingResolve}
                              className="inline-flex items-center gap-1 h-8 rounded-md border border-danger/30 bg-danger/10 px-2.5 text-xs font-medium text-danger hover:bg-danger/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 transition-colors disabled:opacity-40"
                              title="Reject — this hour won't count; the coach will see your reason"
                            >
                              <X className="h-3.5 w-3.5" />
                              Reject
                            </button>
                          </>
                        ) : row.status === "rejected" ? (
                          <span
                            className="inline-flex items-center gap-1 text-xs text-danger whitespace-nowrap"
                            title={row.decisionReason ?? undefined}
                          >
                            <X className="h-3.5 w-3.5" />
                            Rejected
                          </span>
                        ) : row.unscheduled && row.reviewedAt ? (
                          <span
                            className="inline-flex items-center gap-1 text-xs text-fg-subtle whitespace-nowrap"
                            title={`Accepted ${formatDate(row.reviewedAt)} ${formatTime(row.reviewedAt)}`}
                          >
                            <Check className="h-3.5 w-3.5" />
                            Accepted
                          </span>
                        ) : row.reviewedAt ? (
                          <span
                            className="inline-flex items-center gap-1 text-xs text-fg-subtle whitespace-nowrap"
                            title={`Reviewed ${formatDate(row.reviewedAt)} ${formatTime(row.reviewedAt)}`}
                          >
                            <Check className="h-3.5 w-3.5" />
                            Reviewed
                          </span>
                        ) : null}
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
          if (!next) {
            setConfirmRow(null);
            setDeleteError(null);
          }
        }}
        title="Delete this hour log?"
        description={
          <>
            {confirmRow
              ? `${confirmRow.coachName ?? confirmRow.coachEmail} · ${confirmRow.programName} · ${formatDate(confirmRow.startAt)} ${formatTime(confirmRow.startAt)}–${formatTime(confirmRow.endAt)}. This can't be undone.`
              : null}
            {deleteError ? (
              <span role="alert" className="mt-2 block text-danger">
                {deleteError}
              </span>
            ) : null}
          </>
        }
        confirmLabel={isDeleting ? "Deleting…" : "Delete entry"}
        onConfirm={handleConfirmDelete}
        isPending={isDeleting}
      />

      <RejectReasonDialog
        open={rejectRow !== null}
        title={
          rejectRow
            ? `${rejectRow.coachName ?? rejectRow.coachEmail} · ${rejectRow.programName} · ${formatDate(rejectRow.startAt)} ${formatTime(rejectRow.startAt)}–${formatTime(rejectRow.endAt)}`
            : ""
        }
        isPending={rejectRow !== null && pendingResolveId === rejectRow.id}
        onClose={() => setRejectRow(null)}
        onConfirm={(reason) => {
          if (rejectRow) handleRejectConfirm(rejectRow, reason);
        }}
      />
    </>
  );
}

// Reject one coach-submitted hour with a REQUIRED, coach-visible reason. The
// submit stays disabled until the reason is non-empty (trimmed). A small local
// twin of the needs-review card's dialog — kept duplicated so the two client
// islands stay independent.
function RejectReasonDialog({
  open,
  title,
  isPending,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  isPending: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReason("");
    const t = requestAnimationFrame(() => cancelRef.current?.focus());
    return () => cancelAnimationFrame(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isPending) {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, isPending, onClose]);

  if (!open) return null;

  const trimmed = reason.trim();
  const canSubmit = trimmed.length > 0 && !isPending;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Reject hour"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
      onClick={() => {
        if (!isPending) onClose();
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl border border-line bg-surface shadow-[var(--shadow-lg)]"
      >
        <div className="px-5 py-4 border-b border-line">
          <h4 className="text-base font-semibold text-fg">Reject this hour?</h4>
          <p className="mt-1 text-xs text-fg-muted leading-relaxed">
            {title ? `${title}. ` : ""}This hour won&apos;t count toward pay or
            reports. The coach will see your reason.
          </p>
        </div>

        <div className="px-5 py-4">
          <label className="block">
            <span className="text-xs uppercase tracking-wider text-fg-muted mb-1.5 block">
              Reason for rejecting (the coach will see this)
            </span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={isPending}
              rows={3}
              maxLength={500}
              placeholder="Why this hour was rejected"
              className="w-full rounded-lg bg-page border border-line text-fg placeholder:text-fg-subtle px-3 py-2 text-sm focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40 resize-none"
            />
          </label>
        </div>

        <div className="px-5 py-4 border-t border-line flex items-center justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onClose}
            disabled={isPending}
            className="inline-flex items-center justify-center rounded-lg border border-line-strong bg-surface text-fg-muted hover:text-fg hover:-translate-y-px h-9 px-3 text-sm font-medium shadow-[var(--shadow-sm)] hover:shadow-[var(--shadow-md)] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(trimmed)}
            disabled={!canSubmit}
            className="inline-flex items-center justify-center rounded-lg border border-danger/30 bg-danger/10 text-danger hover:bg-danger/20 h-9 px-3 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 transition-colors"
          >
            {isPending ? "Rejecting…" : "Reject hour"}
          </button>
        </div>
      </div>
    </div>
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
