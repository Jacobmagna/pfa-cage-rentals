"use client";

import { useState, useTransition } from "react";
import { Check, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { formatPfaDateMedium, formatPfaTime12h } from "@/lib/timezone";
import { resolveUnscheduledHourLog } from "../hour-log/actions";

// QA10 W3-polish13b: Home-dashboard triage card for still-unreviewed
// unscheduled program-hour logs. A coach logged program hours with no
// matching scheduled block they're a member of. Each row has a Resolve
// button wired to the shared `resolveUnscheduledHourLog` action (which
// revalidates /admin), so resolving here refreshes the card. Rendered by
// the page ONLY when there is at least one such log.
export type UnscheduledAttentionItem = {
  id: string;
  coachName: string | null;
  programName: string;
  startAt: Date;
  endAt: Date;
};

export function UnscheduledAttentionCard({
  items,
  totalCount,
}: {
  items: UnscheduledAttentionItem[];
  totalCount: number;
}) {
  const [pendingResolveId, setPendingResolveId] = useState<string | null>(null);
  const [, startResolveTransition] = useTransition();

  const handleResolve = (id: string) => {
    setPendingResolveId(id);
    startResolveTransition(async () => {
      try {
        await resolveUnscheduledHourLog(id);
      } finally {
        setPendingResolveId(null);
      }
    });
  };

  const moreCount = totalCount - items.length;

  return (
    <section aria-labelledby="unscheduled-attention-heading" className="mb-10">
      <div className="overflow-hidden rounded-2xl border border-danger/30 bg-danger/5 p-5 shadow-[var(--shadow-md)]">
        <div className="flex items-center gap-2">
          <TriangleAlert className="h-4 w-4 shrink-0 text-danger" />
          <h2
            id="unscheduled-attention-heading"
            className="text-sm font-semibold text-fg"
          >
            Unscheduled hours — needs review
          </h2>
          <span className="ml-auto inline-flex items-center rounded-full border border-danger/30 bg-danger/10 px-2 py-0.5 text-[11px] font-semibold tracking-tight text-danger tnum">
            {totalCount}
          </span>
        </div>
        <p className="mt-1.5 text-xs text-fg-muted">
          A coach logged program hours with no matching scheduled block. Review
          and resolve each.
        </p>

        <ul className="mt-4 divide-y divide-danger/15">
          {items.map((item) => {
            const isPendingResolve = pendingResolveId === item.id;
            return (
              <li
                key={item.id}
                className="flex items-center gap-3 py-2.5 first:pt-0"
              >
                <span className="min-w-0 flex-1 truncate text-sm text-fg">
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
                <button
                  type="button"
                  onClick={() => handleResolve(item.id)}
                  disabled={isPendingResolve}
                  className="inline-flex shrink-0 items-center gap-1 h-8 rounded-md border border-line-strong bg-surface px-2.5 text-xs font-medium text-fg-muted hover:text-fg hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors disabled:opacity-40"
                  title="Mark this unscheduled log reviewed"
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
