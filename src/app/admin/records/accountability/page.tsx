import Link from "next/link";
import { ArrowLeft, ShieldAlert } from "lucide-react";
import { requireRole } from "@/lib/authz";
import {
  loadAccountabilityScorecard,
  loadOverdueBalances,
  type AccountabilityEventKind,
  type OverdueRow,
} from "@/lib/server/accountability-data";
import { formatDollars } from "@/lib/format-money";
import { formatPfaDateMedium, formatPfaTime12h } from "@/lib/timezone";

// /admin/records/accountability — per-coach behavioral SCORECARD (1b add-on).
// Aggregates 4 accountability signals (no-shows, late cancels, late logs,
// over-logged) over a 90-day window into one row per active coach, plus a
// unified recent-events feed. This is the home for per-coach PATTERNS —
// distinct from the Needs-review incident queue. The cage-cancel dashboard
// (#26/27) folds in here as the "late cancels" drill-down. Thin server shell —
// guards the role, loads the scorecard, renders. Mirrors the duplicates
// sub-page (back-link + header + empty state) and existing admin table styling.

const EVENT_BADGE: Record<
  AccountabilityEventKind,
  { label: string; className: string }
> = {
  no_show: {
    label: "Not logged",
    className: "border-danger/30 bg-danger/10 text-danger",
  },
  late_cancel: {
    label: "Late rental cancel",
    className: "border-danger/30 bg-danger/10 text-danger",
  },
  late_log: {
    label: "Late work log",
    className: "border-warning/30 bg-warning/10 text-warning",
  },
  over_logged: {
    label: "Over-logged",
    className: "border-warning/30 bg-warning/10 text-warning",
  },
};

// Why-chips for an overdue row. A coach can trip the balance threshold,
// the age threshold, or both — render one chip per reason.
const OVERDUE_REASON_CHIP: Record<OverdueRow["reasons"][number], string> = {
  balance: "Over $350",
  age: "30+ days",
};

function OverdueSection({ rows }: { rows: OverdueRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="overdue-heading">
      <h2
        id="overdue-heading"
        className="mb-3 text-[11.5px] font-semibold uppercase tracking-[0.14em] text-fg-muted"
      >
        Overdue balances
      </h2>
      <div className="overflow-x-auto rounded-xl border border-danger/30 bg-surface shadow-[var(--shadow-sm)]">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted border-b border-line bg-danger/5">
            <tr>
              <th className="px-4 py-3 text-left">Coach</th>
              <th className="px-4 py-3 text-right">Balance</th>
              <th className="px-4 py-3 text-right">Oldest unpaid</th>
              <th className="px-4 py-3 text-left">Why</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((c) => (
              <tr key={c.coachId}>
                <td className="px-4 py-3 font-medium text-fg">
                  {c.coachName ?? "Unknown coach"}
                </td>
                <td className="px-4 py-3 text-right font-mono tnum tabular-nums font-semibold text-danger">
                  {formatDollars(c.balanceCents)}
                </td>
                <td
                  className={`px-4 py-3 text-right font-mono tnum tabular-nums ${
                    c.reasons.includes("age")
                      ? "text-danger font-semibold"
                      : "text-fg-muted"
                  }`}
                >
                  {c.oldestUnpaidAt
                    ? `${c.oldestUnpaidDays} ${
                        c.oldestUnpaidDays === 1 ? "day" : "days"
                      }`
                    : "—"}
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1.5">
                    {c.reasons.map((r) => (
                      <span
                        key={r}
                        className="inline-flex shrink-0 items-center rounded-full border border-danger/30 bg-danger/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-danger"
                      >
                        {OVERDUE_REASON_CHIP[r]}
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default async function AccountabilityPage() {
  await requireRole("admin");

  const [{ rows, recent, window, totals }, overdue] = await Promise.all([
    loadAccountabilityScorecard(),
    loadOverdueBalances(),
  ]);

  const isEmpty =
    totals.totalConcerns === 0 &&
    recent.length === 0 &&
    overdue.count === 0;

  return (
    <>
      <Link
        href="/admin/records"
        className="inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg mb-6 transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to Billing &amp; Records
      </Link>

      <div className="mb-6 space-y-1.5">
        <p className="text-[11.5px] font-semibold uppercase tracking-[0.14em] text-fg-muted">
          Billing &amp; Records
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          Coach accountability
        </h1>
        <p className="text-sm text-fg-muted">
          Per-coach patterns over the last {window.sinceDays} days — scheduled
          blocks with no matching log, late cage-rental cancellations, late work
          logs, and over-logged hours — plus coaches with an overdue cage-rental
          balance.
        </p>
      </div>

      {isEmpty ? (
        <div className="rounded-xl border border-line bg-surface p-12 text-center shadow-[var(--shadow-sm)]">
          <ShieldAlert
            className="mx-auto mb-3 h-7 w-7 text-fg-subtle"
            aria-hidden="true"
          />
          <p className="text-sm font-medium text-fg">
            No accountability flags 🎉
          </p>
          <p className="mt-1.5 text-sm text-fg-muted">
            Every coach is on track.
          </p>
        </div>
      ) : (
        <div className="space-y-10">
          {/* Overdue cage balances — coaches past the policy thresholds
              (balance > $350 OR oldest unpaid rental > 30 days). */}
          <OverdueSection rows={overdue.rows} />

          {/* Per-coach scorecard. Rows arrive sorted most-concerning first;
              clean coaches (totalConcerns 0) are muted at the bottom. */}
          <section aria-labelledby="scorecard-heading">
            <h2
              id="scorecard-heading"
              className="mb-3 text-[11.5px] font-semibold uppercase tracking-[0.14em] text-fg-muted"
            >
              By coach
            </h2>
            <div className="overflow-x-auto rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)]">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted border-b border-line bg-surface-2/50">
                  <tr>
                    <th className="px-4 py-3 text-left">Coach</th>
                    <th className="px-4 py-3 text-right">Not logged</th>
                    <th className="px-4 py-3 text-right">
                      <Link
                        href="/admin/records/accountability/cancellations"
                        className="inline-flex items-center hover:text-fg transition-colors underline decoration-dotted underline-offset-2"
                      >
                        Late rental cancels
                      </Link>
                    </th>
                    <th className="px-4 py-3 text-right">Late work logs</th>
                    <th className="px-4 py-3 text-right">Over-logged</th>
                    <th className="px-4 py-3 text-right">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {rows.map((c) => {
                    const clean = c.totalConcerns === 0;
                    return (
                      <tr key={c.coachId} className={clean ? "opacity-55" : ""}>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-fg">
                              {c.coachName ?? "Unknown coach"}
                            </span>
                            {c.repeatCanceller ? (
                              <span className="inline-flex shrink-0 items-center rounded-full border border-danger/30 bg-danger/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-danger">
                                Repeat
                              </span>
                            ) : null}
                          </div>
                        </td>
                        <td
                          className={`px-4 py-3 text-right font-mono tnum tabular-nums ${
                            c.noShows > 0
                              ? "text-danger font-semibold"
                              : "text-fg-muted"
                          }`}
                        >
                          {c.noShows}
                        </td>
                        <td
                          className={`px-4 py-3 text-right font-mono tnum tabular-nums ${
                            c.lateCancels > 0
                              ? "text-danger font-semibold"
                              : "text-fg-muted"
                          }`}
                        >
                          {c.lateCancels}
                          {c.lateCancels > 0 ? (
                            <span className="ml-1 text-[11px] font-normal text-fg-subtle">
                              {c.lateCancelRatePct}%
                            </span>
                          ) : null}
                        </td>
                        <td
                          className={`px-4 py-3 text-right font-mono tnum tabular-nums ${
                            c.lateLogs > 0
                              ? "text-danger font-semibold"
                              : "text-fg-muted"
                          }`}
                        >
                          {c.lateLogs}
                        </td>
                        <td
                          className={`px-4 py-3 text-right font-mono tnum tabular-nums ${
                            c.overLogged > 0
                              ? "text-danger font-semibold"
                              : "text-fg-muted"
                          }`}
                        >
                          {c.overLogged}
                        </td>
                        <td
                          className={`px-4 py-3 text-right font-mono tnum tabular-nums font-semibold ${
                            clean ? "text-fg-muted" : "text-fg"
                          }`}
                        >
                          {c.totalConcerns}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* Unified recent accountability events — newest first across all
              four signals. */}
          {recent.length > 0 ? (
            <section aria-labelledby="recent-heading">
              <h2
                id="recent-heading"
                className="mb-3 text-[11.5px] font-semibold uppercase tracking-[0.14em] text-fg-muted"
              >
                Recent events
              </h2>
              <div className="overflow-x-auto rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)]">
                <table className="w-full min-w-[720px] text-sm">
                  <thead className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted border-b border-line bg-surface-2/50">
                    <tr>
                      <th className="px-4 py-3 text-left">Type</th>
                      <th className="px-4 py-3 text-left">Coach</th>
                      <th className="px-4 py-3 text-left">What</th>
                      <th className="px-4 py-3 text-left">When</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {recent.map((e, i) => {
                      const badge = EVENT_BADGE[e.kind];
                      return (
                        <tr key={`${e.kind}-${e.coachId}-${e.when.getTime()}-${i}`}>
                          <td className="px-4 py-3">
                            <span
                              className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${badge.className}`}
                            >
                              {badge.label}
                            </span>
                          </td>
                          <td className="px-4 py-3 font-medium text-fg">
                            {e.coachName ?? "Unknown coach"}
                          </td>
                          <td className="px-4 py-3 text-fg-muted">
                            {e.detail}
                          </td>
                          <td className="px-4 py-3 text-fg-muted whitespace-nowrap">
                            {formatPfaDateMedium(e.when)}
                            <span className="text-fg-subtle">
                              {" · "}
                              {formatPfaTime12h(e.when)}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
        </div>
      )}
    </>
  );
}
