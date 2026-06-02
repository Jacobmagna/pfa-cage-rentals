import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { PFA_TIMEZONE } from "@/lib/timezone";

// Per-coach payments summary on /admin/coaches/[id]. Renders the
// owed / paid / pending math + a recent-history list. Linking out
// to /admin/payments avoids duplicating the record dialog here.
//
// Server component — no interactive state. To record a payment for
// this specific coach, the "Record payment" link sends Dad to
// /admin/payments where the dialog can be prefilled via the per-row
// Record buttons; this card just summarizes.

type PaymentSummaryRow = {
  id: string;
  amountCents: number;
  method: "venmo" | "zelle" | "check" | "cash" | "other";
  paidAt: Date;
  reference: string | null;
  note: string | null;
  status: "pending" | "confirmed";
};

export function CoachPaymentsCard({
  owedCents,
  paidCents,
  pendingCents,
  payments,
}: {
  coachId: string;
  owedCents: number;
  paidCents: number;
  pendingCents: number;
  payments: PaymentSummaryRow[];
}) {
  const balanceCents = owedCents - paidCents;

  return (
    <section className="my-8 rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)] p-5">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <h2 className="text-base font-semibold tracking-tight">Payments</h2>
          <p className="text-xs text-fg-subtle mt-0.5">
            All-time owed minus confirmed payments. Pending entries wait in
            the admin inbox.
          </p>
        </div>
        <Link
          href="/admin/payments"
          className="inline-flex items-center gap-1 rounded-lg border border-line-strong bg-surface text-fg-muted hover:text-fg hover:-translate-y-px shadow-[var(--shadow-sm)] hover:shadow-[var(--shadow-md)] h-8 px-3 text-xs font-medium transition"
        >
          Record payment
          <ArrowUpRight className="h-3 w-3" />
        </Link>
      </div>

      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-px rounded-lg border border-line bg-line overflow-hidden mb-5">
        <Stat label="Owed" value={formatDollars(owedCents)} />
        <Stat label="Paid" value={formatDollars(paidCents)} />
        <Stat
          label="Balance"
          value={formatDollars(balanceCents)}
          accent={balanceCents > 0}
        />
        <Stat
          label="Pending"
          value={formatDollars(pendingCents)}
          muted={pendingCents === 0}
        />
      </dl>

      {payments.length === 0 ? (
        <p className="text-xs text-fg-subtle italic">
          No payments recorded yet.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)]">
          <table className="w-full min-w-[480px]">
            <thead className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted border-b border-line bg-surface-2/50">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">Date</th>
                <th className="px-3 py-2 text-left font-semibold">Method</th>
                <th className="px-3 py-2 text-right font-semibold">Amount</th>
                <th className="px-3 py-2 text-left font-semibold">Status</th>
                <th className="px-3 py-2 text-left font-semibold">Reference</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr
                  key={p.id}
                  className="border-t border-line hover:bg-surface-2 transition-colors text-xs"
                >
                  <td className="px-3 py-2 font-mono tnum tabular-nums whitespace-nowrap">
                    {formatDate(p.paidAt)}
                  </td>
                  <td className="px-3 py-2 text-fg-muted">
                    {p.method.charAt(0).toUpperCase() + p.method.slice(1)}
                  </td>
                  <td className="px-3 py-2 font-mono tnum tabular-nums text-right whitespace-nowrap">
                    {formatDollars(p.amountCents)}
                  </td>
                  <td className="px-3 py-2">
                    <StatusPill status={p.status} />
                  </td>
                  <td className="px-3 py-2 text-fg-subtle truncate max-w-[160px]">
                    {p.reference ?? "—"}
                    {p.note ? (
                      <span className="block text-[10px] text-fg-subtle/80 mt-0.5">
                        {p.note}
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Stat({
  label,
  value,
  accent,
  muted,
}: {
  label: string;
  value: string;
  accent?: boolean;
  muted?: boolean;
}) {
  return (
    <div className="bg-surface px-3 py-2.5">
      <p className="text-[10px] uppercase tracking-[0.14em] text-fg-muted">
        {label}
      </p>
      <p
        className={[
          "mt-1 font-mono tnum tabular-nums tracking-tight text-base",
          accent ? "text-gold-strong" : muted ? "text-fg-subtle" : "text-fg",
        ].join(" ")}
      >
        {value}
      </p>
    </div>
  );
}

function StatusPill({ status }: { status: "pending" | "confirmed" }) {
  if (status === "confirmed") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-success/10 text-success ring-1 ring-inset ring-success/30 px-1.5 py-px text-[9px] font-medium uppercase tracking-wider">
        Confirmed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-warning/10 text-warning ring-1 ring-inset ring-warning/30 px-1.5 py-px text-[9px] font-medium uppercase tracking-wider">
      Pending
    </span>
  );
}

function formatDollars(cents: number): string {
  const abs = Math.abs(cents);
  const dollars = (abs / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return cents < 0 ? `-$${dollars}` : `$${dollars}`;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    timeZone: PFA_TIMEZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
