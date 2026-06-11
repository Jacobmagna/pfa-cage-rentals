// QA2 #7 — READ-ONLY rate-change history for this coach, derived from the
// existing audit_log (no new table). The page builds the rows (resolving
// program names + actor display) and passes them here; this component is
// purely presentational.
//
// Server component (no "use client") — there's nothing interactive.

import { formatPfaDateMedium, formatPfaTime12h } from "@/lib/timezone";

export type RateHistoryRow = {
  /** Stable key for React (audit row id). */
  id: string;
  /** "create" | "update" | "delete". */
  action: "create" | "update" | "delete";
  /** What the rate applies to, e.g. "Cage" or a program name. */
  target: string;
  /** "Rental rate" or "Work rate" — which kind of override. */
  kind: string;
  /** Formatted prior rate as displayed (e.g. "$22.00 / 30 min"), or null. */
  beforeLabel: string | null;
  /** Formatted new rate as displayed, or null (for a delete). */
  afterLabel: string | null;
  /** When the change happened. */
  ts: Date;
  /** Who made the change (name or email), or "—" if unknown. */
  actor: string;
};

const ACTION_VERB: Record<RateHistoryRow["action"], string> = {
  create: "Set",
  update: "Changed",
  delete: "Removed",
};

export function RateHistoryCard({ rows }: { rows: RateHistoryRow[] }) {
  return (
    <section className="my-8 rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)] overflow-hidden">
      <header className="px-5 py-4 border-b border-line">
        <h3 className="text-base font-semibold text-fg">Rate history</h3>
        <p className="mt-1 text-xs text-fg-muted leading-relaxed">
          Every rate-override change for this coach, newest first. Read-only —
          derived from the audit log.
        </p>
      </header>

      {rows.length === 0 ? (
        <p className="px-5 py-6 text-sm text-fg-muted">
          No rate-override changes recorded for this coach.
        </p>
      ) : (
        <ol className="divide-y divide-line/60">
          {rows.map((row) => (
            <li key={row.id} className="px-5 py-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-fg">
                    {ACTION_VERB[row.action]} {row.kind.toLowerCase()} —{" "}
                    <span className="text-fg">{row.target}</span>
                  </p>
                  <p className="mt-0.5 text-sm text-fg-muted font-mono tnum tabular-nums">
                    {row.beforeLabel ?? "—"}
                    <span className="mx-1.5 text-fg-subtle">→</span>
                    {row.afterLabel ?? "—"}
                  </p>
                  <p className="mt-1 text-[11px] text-fg-subtle">
                    by {row.actor}
                  </p>
                </div>
                <p className="shrink-0 text-right text-[11px] text-fg-subtle font-mono tnum tabular-nums">
                  {formatPfaDateMedium(row.ts)}
                  <br />
                  {formatPfaTime12h(row.ts)}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
