// payment-statement SPEC §8 — the Statements tab when MORE THAN ONE coach is in
// scope.
//
// Reaching the tab from the Reports filter bar means the usual case is "all
// coaches, one month", not one coach. That is not a degraded statement view —
// it is the job Mark opens Reports to do: decide who owes him and who he owes.
// And it is the one thing no screen in this app does today: /admin/reports is
// ranged but GROSS, /admin/payments and the coach page are netted but ALL-TIME.
// This roll-up is ranged AND netted, per account, which is the whole feature.
//
// 🔴 Two balance columns, never a third that adds them. The directions are
// opposite (coach→PFA vs PFA→coach) and this codebase forbids summing them in
// three separate places. Column HEADERS carry the direction in words so a
// printed or screenshotted row can't lose it.

import Link from "next/link";
import { AlertTriangle, ArrowRight } from "lucide-react";
import { formatDollarsExact } from "@/lib/format-money";

export type StatementRosterEntry = {
  coachId: string;
  coachName: string;
  /** Positive = coach owes PFA; negative = credit. */
  cageBalanceCents: number;
  /** Positive = PFA owes coach. */
  workBalanceCents: number;
  /**
   * Payments carrying no covers-through date. ⚠️ ALL-TIME, not ranged — an
   * untagged payment belongs to no period, so there is no honest way to filter
   * it by one. The column is labelled "all time" for that reason.
   */
  unappliedCents: number;
};

export function StatementRoster({
  rows,
  periodLabel,
  hrefForCoach,
}: {
  rows: StatementRosterEntry[];
  periodLabel: string;
  hrefForCoach: (coachId: string) => string;
}) {
  const totalUnapplied = rows.reduce((n, r) => n + r.unappliedCents, 0);
  const owingCount = rows.filter((r) => r.cageBalanceCents > 0).length;
  const owedCount = rows.filter((r) => r.workBalanceCents > 0).length;

  return (
    <section className="rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)] p-5">
      <div className="mb-4">
        <h2 className="text-base font-semibold tracking-tight">
          Statements — {periodLabel}
        </h2>
        <p className="mt-0.5 text-xs text-fg-subtle">
          Where each coach stands at the end of this period: charges in the
          period, minus payments that <em>cover</em> the period. Open one to
          read or print its statement.
        </p>
      </div>

      <dl className="mb-5 grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-3">
        <Stat label="Coaches owing PFA" value={String(owingCount)} />
        <Stat label="Coaches PFA owes" value={String(owedCount)} />
        <Stat
          label="Payments with no period stated"
          value={formatDollarsExact(totalUnapplied)}
          hint={
            totalUnapplied > 0
              ? "Counted in no period — tag these to place them"
              : undefined
          }
        />
      </dl>

      {/* SPEC §11 — the caveat has to ride on THIS surface too. The individual
          work statement carries it, but this table shows the same payout
          figures for the whole roster at once, so omitting it here would be the
          exact "symmetrical and silent" failure §11 forbids. */}
      <p className="mb-3 flex gap-2.5 rounded-lg border border-warning/40 bg-warning/5 p-3 text-xs leading-relaxed">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <span>
          <span className="font-medium">Work pay is what the logged work is
          worth — not what is still owed.</span>{" "}
          PFA pays coaches outside this system, so any payout that was never
          recorded here is not subtracted. The cage-rental column has no such
          gap: those charges and payments both live in the app.
        </span>
      </p>

      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="border-b border-line bg-surface-2/50 text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
            <tr>
              <th scope="col" className="px-3 py-2 text-left">
                Coach
              </th>
              {/* Direction in the HEADER, in words. */}
              <th scope="col" className="px-3 py-2 text-right">
                Cage rentals
                <span className="block font-normal normal-case tracking-normal text-fg-subtle">
                  coach owes PFA
                </span>
              </th>
              <th scope="col" className="px-3 py-2 text-right">
                Work pay
                <span className="block font-normal normal-case tracking-normal text-fg-subtle">
                  PFA owes coach
                </span>
              </th>
              <th scope="col" className="px-3 py-2 text-right">
                No period stated
                <span className="block font-normal normal-case tracking-normal text-fg-subtle">
                  all time
                </span>
              </th>
              <th scope="col" className="px-3 py-2 text-right">
                <span className="sr-only">Statement</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.coachId}
                className="border-b border-line/60 last:border-0 hover:bg-surface-2/40"
              >
                <td className="px-3 py-2.5 font-medium">{row.coachName}</td>
                <Money cents={row.cageBalanceCents} />
                <Money cents={row.workBalanceCents} />
                <td className="px-3 py-2.5 text-right tabular-nums">
                  {row.unappliedCents > 0 ? (
                    <span className="text-warning">
                      {formatDollarsExact(row.unappliedCents)}
                    </span>
                  ) : (
                    <span className="text-fg-disabled">—</span>
                  )}
                </td>
                <td className="px-3 py-2.5 text-right">
                  <Link
                    href={hrefForCoach(row.coachId)}
                    className="inline-flex items-center gap-1 text-xs font-medium text-fg-muted transition-colors hover:text-fg"
                  >
                    Statement
                    <ArrowRight className="h-3 w-3" />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-fg-subtle">
        The two balance columns run in opposite directions and are never added
        together. A cage balance in parentheses is a credit — that coach has
        paid ahead. <span className="font-medium">No period stated</span> is
        all-time, not this period: a payment with no coverage date belongs to no
        period at all, which is why it needs one.
      </p>
    </section>
  );
}

function Money({ cents }: { cents: number }) {
  if (cents === 0) {
    return (
      <td className="px-3 py-2.5 text-right tabular-nums text-fg-disabled">
        —
      </td>
    );
  }
  // Accounting convention for a credit: parentheses, not a minus sign. Mark
  // reads statements; a bare "-$40.00" on a balance column is ambiguous about
  // WHICH way it went, and parentheses are the convention he already knows.
  const credit = cents < 0;
  return (
    <td
      className={[
        "px-3 py-2.5 text-right tabular-nums",
        credit ? "text-fg-muted" : "font-medium",
      ].join(" ")}
    >
      {credit
        ? `(${formatDollarsExact(Math.abs(cents))})`
        : formatDollarsExact(cents)}
    </td>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="bg-surface px-4 py-3">
      <dt className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
        {label}
      </dt>
      <dd className="mt-1 text-lg font-semibold tabular-nums tracking-tight">
        {value}
      </dd>
      {hint ? <p className="mt-0.5 text-[11px] text-fg-subtle">{hint}</p> : null}
    </div>
  );
}
