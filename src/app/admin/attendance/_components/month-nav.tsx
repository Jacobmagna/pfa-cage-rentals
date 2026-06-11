// Server-driven month navigation for the admin attendance grids
// (QA2 #12/#13). Renders the current month label flanked by ‹ prev /
// next › links that set `?month=YYYY-MM` while preserving any other
// query params (e.g. ?programId / ?athleteId). No client JS — plain
// <Link>s, same pattern as the report filter form.

import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

export function MonthNav({
  basePath,
  label,
  prevMonth,
  nextMonth,
  extraParams,
}: {
  /** Page path the links point at, e.g. "/admin/attendance/by-program". */
  basePath: string;
  /** "June 2026" — the selected-month label. */
  label: string;
  /** "YYYY-MM" for the ‹ prev link. */
  prevMonth: string;
  /** "YYYY-MM" for the next › link. */
  nextMonth: string;
  /** Other params to preserve on the nav links (programId, athleteId…). */
  extraParams?: Record<string, string>;
}) {
  const href = (month: string) => {
    const sp = new URLSearchParams(extraParams);
    sp.set("month", month);
    return `${basePath}?${sp.toString()}`;
  };

  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-3 shadow-[var(--shadow-sm)]">
      <Link
        href={href(prevMonth)}
        prefetch={false}
        aria-label="Previous month"
        className="inline-flex items-center gap-1 rounded-md border border-line-strong bg-surface px-3 h-9 text-sm font-medium text-fg-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden />
        Prev
      </Link>

      <span className="text-sm font-semibold text-fg tnum">{label}</span>

      <Link
        href={href(nextMonth)}
        prefetch={false}
        aria-label="Next month"
        className="inline-flex items-center gap-1 rounded-md border border-line-strong bg-surface px-3 h-9 text-sm font-medium text-fg-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
      >
        Next
        <ChevronRight className="h-4 w-4" aria-hidden />
      </Link>
    </div>
  );
}
