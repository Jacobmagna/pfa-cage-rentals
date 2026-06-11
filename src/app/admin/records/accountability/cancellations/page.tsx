import Link from "next/link";
import { ArrowLeft, CalendarX } from "lucide-react";
import { requireRole } from "@/lib/authz";
import { loadCancellationsDashboard } from "@/lib/server/cancellations-data";
import type { CancelCategory } from "@/lib/cancellation";
import { formatPfaDateMedium, formatPfaTime12h } from "@/lib/timezone";

// /admin/records/accountability/cancellations — billable #26/27. Read-only
// audit of deleted cage rentals: a per-coach pattern rollup (most-concerning
// first, repeat offenders flagged) plus a recent-cancellations feed with
// derived timing categories. The "late cancels" drill-down of the coach
// accountability scorecard. Thin server shell — guards the role, loads the
// dashboard, renders. Mirrors the duplicates sub-page (back-link + header +
// empty state) and the existing admin table styling.

const CATEGORY_BADGE: Record<
  CancelCategory,
  { label: string; className: string }
> = {
  last_minute: {
    label: "Last-minute",
    className: "border-danger/30 bg-danger/10 text-danger",
  },
  mid_session: {
    label: "Mid-session",
    className: "border-danger/30 bg-danger/10 text-danger",
  },
  short_notice: {
    label: "Short notice",
    className: "border-warning/30 bg-warning/10 text-warning",
  },
  advance: {
    label: "Advance",
    className: "border-line-strong bg-surface-2 text-fg-muted",
  },
  after_end: {
    label: "After-end",
    className: "border-line-strong bg-surface-2 text-fg-muted",
  },
};

// Humanize the stored lead time. Positive = cancelled before start;
// <= 0 = cancelled at/after start (during or after the rental).
function humanizeLeadTime(mins: number): string {
  if (mins <= 0) return "during/after";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m before`;
  if (m === 0) return `${h}h before`;
  return `${h}h ${m}m before`;
}

export default async function CancellationsPage() {
  await requireRole("admin");

  const { rollup, recent } = await loadCancellationsDashboard();

  return (
    <>
      <Link
        href="/admin/records/accountability"
        className="inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg mb-6 transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to Coach accountability
      </Link>

      <div className="mb-6 space-y-1.5">
        <p className="text-[11.5px] font-semibold uppercase tracking-[0.14em] text-fg-muted">
          Rentals
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          Cage-rental cancellations
        </h1>
        <p className="text-sm text-fg-muted">
          When coaches remove their cage rentals, relative to the rental&apos;s
          start. Last-minute and mid-session removals are the concerning ones;
          a coach with a repeated pattern is flagged. (This is rentals only —
          cancelled work blocks appear in the Needs-review queue.)
        </p>
      </div>

      {recent.length === 0 ? (
        <div className="rounded-xl border border-line bg-surface p-12 text-center shadow-[var(--shadow-sm)]">
          <CalendarX
            className="mx-auto mb-3 h-7 w-7 text-fg-subtle"
            aria-hidden="true"
          />
          <p className="text-sm font-medium text-fg">
            No cancellations recorded 🎉
          </p>
          <p className="mt-1.5 text-sm text-fg-muted">
            Nobody has removed a cage rental in the last 90 days.
          </p>
        </div>
      ) : (
        <div className="space-y-10">
          {/* Per-coach pattern rollup. Owner-cancellations only (admin removals
              are excluded from a coach's totals). Most-concerning first. */}
          <section aria-labelledby="rollup-heading">
            <h2
              id="rollup-heading"
              className="mb-3 text-[11.5px] font-semibold uppercase tracking-[0.14em] text-fg-muted"
            >
              By coach
            </h2>
            {rollup.length === 0 ? (
              <p className="rounded-xl border border-line bg-surface p-6 text-sm text-fg-muted shadow-[var(--shadow-sm)]">
                No coach-initiated cancellations yet — every removal in this
                window was made by an admin.
              </p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)]">
                <table className="w-full min-w-[640px] text-sm">
                  <thead className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted border-b border-line bg-surface-2/50">
                    <tr>
                      <th className="px-4 py-3 text-left">Coach</th>
                      <th className="px-4 py-3 text-right">Total</th>
                      <th className="px-4 py-3 text-right">Last-minute</th>
                      <th className="px-4 py-3 text-right">Mid-session</th>
                      <th className="px-4 py-3 text-right">Late-rate</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {rollup.map((c) => (
                      <tr key={c.coachId}>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-fg">
                              {c.coachName ?? "Unknown coach"}
                            </span>
                            {c.repeatOffender ? (
                              <span className="inline-flex shrink-0 items-center rounded-full border border-danger/30 bg-danger/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-danger">
                                Repeat
                              </span>
                            ) : null}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right font-mono tnum tabular-nums text-fg-muted">
                          {c.total}
                        </td>
                        <td
                          className={`px-4 py-3 text-right font-mono tnum tabular-nums ${
                            c.lastMinute > 0 ? "text-danger font-semibold" : "text-fg-muted"
                          }`}
                        >
                          {c.lastMinute}
                        </td>
                        <td
                          className={`px-4 py-3 text-right font-mono tnum tabular-nums ${
                            c.midSession > 0 ? "text-danger font-semibold" : "text-fg-muted"
                          }`}
                        >
                          {c.midSession}
                        </td>
                        <td
                          className={`px-4 py-3 text-right font-mono tnum tabular-nums ${
                            c.lateRatePct >= 50 ? "text-danger font-semibold" : "text-fg"
                          }`}
                        >
                          {c.lateRatePct}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Recent cancellations feed — newest first, every removal in the
              window (coach- and admin-initiated). */}
          <section aria-labelledby="recent-heading">
            <h2
              id="recent-heading"
              className="mb-3 text-[11.5px] font-semibold uppercase tracking-[0.14em] text-fg-muted"
            >
              Recent
            </h2>
            <div className="overflow-x-auto rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)]">
              <table className="w-full min-w-[820px] text-sm">
                <thead className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted border-b border-line bg-surface-2/50">
                  <tr>
                    <th className="px-4 py-3 text-left">Coach</th>
                    <th className="px-4 py-3 text-left">Resource</th>
                    <th className="px-4 py-3 text-left">Rental start</th>
                    <th className="px-4 py-3 text-left">Cancelled</th>
                    <th className="px-4 py-3 text-left">Lead time</th>
                    <th className="px-4 py-3 text-left">Category</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {recent.map((r) => {
                    const badge = CATEGORY_BADGE[r.category];
                    return (
                      <tr key={r.id}>
                        <td className="px-4 py-3">
                          <div className="min-w-0">
                            <span className="font-medium text-fg">
                              {r.coachName ?? "Unknown coach"}
                            </span>
                            {r.byAdmin ? (
                              <span className="block text-[11px] text-fg-subtle">
                                removed by {r.actorName ?? "an admin"}
                              </span>
                            ) : null}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-fg-muted">
                          {r.resourceName ?? "—"}
                        </td>
                        <td className="px-4 py-3 text-fg-muted whitespace-nowrap">
                          {formatPfaDateMedium(r.startAt)}
                          <span className="text-fg-subtle">
                            {" · "}
                            {formatPfaTime12h(r.startAt)}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-fg-muted whitespace-nowrap">
                          {formatPfaDateMedium(r.cancelledAt)}
                          <span className="text-fg-subtle">
                            {" · "}
                            {formatPfaTime12h(r.cancelledAt)}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-fg-muted whitespace-nowrap">
                          {humanizeLeadTime(r.leadTimeMins)}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${badge.className}`}
                          >
                            {badge.label}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
