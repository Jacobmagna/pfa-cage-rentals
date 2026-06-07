"use client";

import { useState, useTransition } from "react";
import { Check, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { formatPfaDateMedium, formatPfaTime12h } from "@/lib/timezone";
import {
  resolveCancellation,
  resolveNoShow,
  resolveUnscheduledHourLog,
} from "../hour-log/actions";

// QA10 W3-polish15b-ii: unified Home-dashboard triage card for the admin
// "needs review" queue. Three tagged alert types are merged + sorted by the
// page, then rendered here:
//   • unscheduled — coach logged program hours with no matching block
//   • cancelled   — coach cancelled their assignment to a scheduled block
//   • no_show     — coach was scheduled but logged no matching hours
// Each row's Resolve button dispatches to the matching shared action (all of
// which revalidate /admin), so resolving here refreshes the card.
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
    : i.type === "cancelled"
      ? `c:${i.flagId}`
      : `n:${i.blockId}:${i.coachId}`;

const TAG: Record<
  NeedsReviewItem["type"],
  { label: string; className: string }
> = {
  unscheduled: {
    label: "Unscheduled",
    className: "border-gold/30 bg-gold/10 text-gold-strong",
  },
  cancelled: {
    label: "Cancelled",
    className: "border-line-strong bg-surface-2 text-fg-muted",
  },
  no_show: {
    label: "No-show",
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
  const [, startResolveTransition] = useTransition();

  const handleResolve = (item: NeedsReviewItem) => {
    const key = keyOf(item);
    setPendingKey(key);
    startResolveTransition(async () => {
      try {
        if (item.type === "unscheduled") {
          await resolveUnscheduledHourLog(item.id);
        } else if (item.type === "cancelled") {
          await resolveCancellation(item.flagId);
        } else {
          await resolveNoShow(item.blockId, item.coachId);
        }
      } finally {
        setPendingKey(null);
      }
    });
  };

  const moreCount = totalCount - items.length;

  return (
    <section aria-labelledby="needs-review-heading" className="mb-10">
      <div className="overflow-hidden rounded-2xl border border-danger/30 bg-danger/5 p-5 shadow-[var(--shadow-md)]">
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
        <p className="mt-1.5 text-xs text-fg-muted">
          Coaches logging unscheduled hours, cancelling scheduled blocks, or not
          logging hours they were scheduled for.
        </p>

        <ul className="mt-4 divide-y divide-danger/15">
          {items.map((item) => {
            const key = keyOf(item);
            const isPendingResolve = pendingKey === key;
            const tag = TAG[item.type];
            const note = item.type === "cancelled" ? item.note : null;
            return (
              <li
                key={key}
                className="flex items-start gap-3 py-2.5 first:pt-0"
              >
                <span className="min-w-0 flex-1 text-sm text-fg">
                  <span className="flex flex-wrap items-center gap-2">
                    <span
                      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${tag.className}`}
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
                      </span>
                    </span>
                  </span>
                  {note && note.trim().length > 0 ? (
                    <span className="mt-1 block truncate text-xs text-fg-muted">
                      “{note}”
                    </span>
                  ) : null}
                </span>
                <button
                  type="button"
                  onClick={() => handleResolve(item)}
                  disabled={isPendingResolve}
                  className="inline-flex shrink-0 items-center gap-1 h-8 rounded-md border border-line-strong bg-surface px-2.5 text-xs font-medium text-fg-muted hover:text-fg hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors disabled:opacity-40"
                  title="Mark this item reviewed"
                >
                  <Check className="h-3.5 w-3.5" />
                  {isPendingResolve ? "Resolving…" : "Resolve"}
                </button>
              </li>
            );
          })}
        </ul>

        {moreCount > 0 ? (
          <p className="mt-3 text-xs text-fg-muted">+{moreCount} more</p>
        ) : null}

        <Link
          href="/admin/hour-log"
          className="mt-4 inline-flex items-center text-xs font-medium text-fg-muted hover:text-fg transition-colors"
        >
          Review all in Hour Log →
        </Link>
      </div>
    </section>
  );
}
