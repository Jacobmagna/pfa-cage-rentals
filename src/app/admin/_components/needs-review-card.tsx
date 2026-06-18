"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Check, TriangleAlert, X } from "lucide-react";
import Link from "next/link";
import { formatPfaDateMedium, formatPfaTime12h } from "@/lib/timezone";
import {
  acceptNeedsReviewLog,
  rejectNeedsReviewLog,
  resolveCancellation,
  resolveNoShow,
} from "../hour-log/actions";

// QA10 W3-polish15b-ii: unified Home-dashboard triage card for the admin
// "needs review" queue. Three tagged alert types are merged + sorted by the
// page, then rendered here:
//   • unscheduled   — "Off-schedule log": coach logged program hours with no
//                     matching block
//   • wrong_time    — log overlaps a block but mismatches it (reconciliation)
//   • double_logged — two overlapping logs for the same coach (dup/double-pay)
//   • cancelled     — "Cancelled work block": coach cancelled their assignment
//                     to a scheduled block (NOT a cage-rental cancellation)
//   • no_show       — "Not logged": a scheduled block has no matching log (this
//                     is NOT an accusation the player didn't show up)
// Hour-backed types (unscheduled / wrong_time / double_logged) carry a real
// posted hour log, so they get Accept (keep posted + mark reviewed) + Reject
// (flip to rejected with a coach-visible reason). Cancelled / no_show have no
// coach-submitted hour, so they keep the single Resolve button. All actions
// revalidate /admin, so acting here refreshes the card.
export type NeedsReviewItem =
  | {
      type: "unscheduled";
      id: string;
      coachName: string | null;
      programName: string;
      startAt: Date;
      endAt: Date;
    }
  | {
      type: "wrong_time";
      id: string;
      coachName: string | null;
      programName: string;
      startAt: Date;
      endAt: Date;
      detail: string | null;
    }
  | {
      type: "double_logged";
      id: string;
      coachName: string | null;
      programName: string;
      startAt: Date;
      endAt: Date;
    }
  | {
      type: "cancelled";
      flagId: string;
      coachName: string | null;
      programName: string;
      startAt: Date;
      endAt: Date;
      note: string | null;
    }
  | {
      type: "no_show";
      blockId: string;
      coachId: string;
      coachName: string | null;
      programName: string;
      startAt: Date;
      endAt: Date;
    };

const keyOf = (i: NeedsReviewItem) =>
  i.type === "unscheduled"
    ? `u:${i.id}`
    : i.type === "wrong_time"
      ? `w:${i.id}`
      : i.type === "double_logged"
        ? `d:${i.id}`
        : i.type === "cancelled"
          ? `c:${i.flagId}`
          : `n:${i.blockId}:${i.coachId}`;

const TAG: Record<
  NeedsReviewItem["type"],
  { label: string; className: string }
> = {
  unscheduled: {
    label: "Off-schedule log",
    className: "border-gold/30 bg-gold/10 text-gold-strong",
  },
  wrong_time: {
    label: "Wrong time",
    className: "border-warning/30 bg-warning/10 text-warning",
  },
  double_logged: {
    label: "Double-logged",
    className: "border-danger/30 bg-danger/10 text-danger",
  },
  cancelled: {
    label: "Cancelled work block",
    className: "border-line-strong bg-surface-2 text-fg-muted",
  },
  no_show: {
    label: "Not logged",
    className: "border-danger/30 bg-danger/10 text-danger",
  },
};

export function NeedsReviewCard({
  items,
  totalCount,
}: {
  items: NeedsReviewItem[];
  totalCount: number;
}) {
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [, startResolveTransition] = useTransition();
  // Reject dialog targets one hour-backed item at a time.
  const [rejectTarget, setRejectTarget] = useState<{
    id: string;
    key: string;
    title: string;
  } | null>(null);

  // Single Resolve path — cancelled / no_show only (no coach-submitted hour).
  const handleResolve = (item: NeedsReviewItem) => {
    const key = keyOf(item);
    setPendingKey(key);
    startResolveTransition(async () => {
      try {
        if (item.type === "cancelled") {
          await resolveCancellation(item.flagId);
        } else if (item.type === "no_show") {
          await resolveNoShow(item.blockId, item.coachId);
        }
      } finally {
        setPendingKey(null);
      }
    });
  };

  // Accept = keep the hour posted + counting, mark reviewed. Only valid for the
  // three hour-backed types (item.id = the hour-log id).
  const handleAccept = (id: string, key: string) => {
    setPendingKey(key);
    startResolveTransition(async () => {
      try {
        await acceptNeedsReviewLog(id);
      } finally {
        setPendingKey(null);
      }
    });
  };

  const handleRejectConfirm = (id: string, key: string, reason: string) => {
    setPendingKey(key);
    startResolveTransition(async () => {
      try {
        await rejectNeedsReviewLog(id, reason);
        setRejectTarget(null);
      } finally {
        setPendingKey(null);
      }
    });
  };

  const COLLAPSED_LIMIT = 5;
  const visibleItems = expanded ? items : items.slice(0, COLLAPSED_LIMIT);
  const moreCount = items.length - COLLAPSED_LIMIT;

  return (
    <section aria-labelledby="needs-review-heading" className="mb-10">
      <div className="overflow-hidden rounded-2xl border border-danger/30 bg-danger/5 p-4 shadow-[var(--shadow-md)]">
        <div className="flex items-center gap-2">
          <TriangleAlert className="h-4 w-4 shrink-0 text-danger" />
          <h2
            id="needs-review-heading"
            className="text-sm font-semibold text-fg"
          >
            Needs review
          </h2>
          <span className="ml-auto inline-flex items-center rounded-full border border-danger/30 bg-danger/10 px-2 py-0.5 text-[11px] font-semibold tracking-tight text-danger tnum">
            {totalCount}
          </span>
        </div>
        <p className="mt-1 text-xs text-fg-muted">
          Coaches logging unscheduled, wrong-time, or double-logged hours,
          cancelling scheduled blocks, or not logging hours they were scheduled
          for.
        </p>

        <ul className="mt-3 divide-y divide-danger/15">
          {visibleItems.map((item) => {
            const key = keyOf(item);
            const isPendingResolve = pendingKey === key;
            const tag = TAG[item.type];
            // Optional trailing note, kept INLINE in the single truncating
            // span so rows stay one line: cancelled → cancellation reason,
            // wrong_time → reconciliation detail.
            const extra =
              item.type === "cancelled"
                ? item.note
                : item.type === "wrong_time"
                  ? item.detail
                  : null;
            const extraText =
              extra && extra.trim().length > 0 ? ` — “${extra.trim()}”` : "";
            const lineTitle = `${item.coachName ?? "Unknown coach"} · ${item.programName} · ${formatPfaDateMedium(item.startAt)} ${formatPfaTime12h(item.startAt)}–${formatPfaTime12h(item.endAt)}${extraText}`;
            return (
              <li
                key={key}
                className="flex flex-col items-stretch gap-1.5 py-2 first:pt-0 sm:flex-row sm:items-center sm:gap-3"
              >
                <span
                  className="flex min-w-0 flex-1 items-center gap-2 text-sm text-fg"
                  title={lineTitle}
                >
                  <span
                    className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${tag.className}`}
                  >
                    {tag.label}
                  </span>
                  <span className="min-w-0 truncate">
                    <span className="font-medium">
                      {item.coachName ?? "Unknown coach"}
                    </span>
                    <span className="text-fg-muted">
                      {" · "}
                      {item.programName}
                      {" · "}
                      {formatPfaDateMedium(item.startAt)}{" "}
                      {formatPfaTime12h(item.startAt)}–
                      {formatPfaTime12h(item.endAt)}
                      {extraText}
                    </span>
                  </span>
                </span>
                {item.type === "unscheduled" ||
                item.type === "wrong_time" ||
                item.type === "double_logged" ? (
                  <div className="inline-flex shrink-0 self-end sm:self-auto items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => handleAccept(item.id, key)}
                      disabled={isPendingResolve}
                      className="inline-flex items-center gap-1 h-8 rounded-md border border-success/30 bg-success/10 px-2.5 text-xs font-medium text-success hover:bg-success/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-success/40 transition-colors disabled:opacity-40"
                      title="Accept — keep this hour posted and counting"
                    >
                      <Check className="h-3.5 w-3.5" />
                      {isPendingResolve ? "Saving…" : "Accept"}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setRejectTarget({ id: item.id, key, title: lineTitle })
                      }
                      disabled={isPendingResolve}
                      className="inline-flex items-center gap-1 h-8 rounded-md border border-danger/30 bg-danger/10 px-2.5 text-xs font-medium text-danger hover:bg-danger/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 transition-colors disabled:opacity-40"
                      title="Reject — this hour won't count; the coach will see your reason"
                    >
                      <X className="h-3.5 w-3.5" />
                      Reject
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleResolve(item)}
                    disabled={isPendingResolve}
                    className="inline-flex shrink-0 self-end sm:self-auto items-center gap-1 h-8 rounded-md border border-line-strong bg-surface px-2.5 text-xs font-medium text-fg-muted hover:text-fg hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors disabled:opacity-40"
                    title="Mark this item reviewed"
                  >
                    <Check className="h-3.5 w-3.5" />
                    {isPendingResolve ? "Resolving…" : "Resolve"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>

        {moreCount > 0 ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="mt-3 inline-flex items-center text-xs font-medium text-fg-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 rounded transition-colors"
          >
            {expanded ? "Show less" : `Show all (${totalCount})`}
          </button>
        ) : null}

        <div>
          <Link
            href="/admin/hour-log"
            className="mt-4 inline-flex items-center text-xs font-medium text-fg-muted hover:text-fg transition-colors"
          >
            Review all in Work Log →
          </Link>
        </div>
      </div>

      <RejectReasonDialog
        open={rejectTarget !== null}
        title={rejectTarget?.title ?? ""}
        isPending={rejectTarget !== null && pendingKey === rejectTarget.key}
        onClose={() => setRejectTarget(null)}
        onConfirm={(reason) => {
          if (rejectTarget) {
            handleRejectConfirm(rejectTarget.id, rejectTarget.key, reason);
          }
        }}
      />
    </section>
  );
}

// Small modal for rejecting a coach-submitted hour. The reason is REQUIRED
// (the coach will see it), so the submit stays disabled until it's non-empty.
// Mirrors the held-row reject dialog chrome but enforces a reason.
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
            {title
              ? `${title}. `
              : ""}
            This hour won&apos;t count toward pay or reports. The coach will see
            your reason.
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
