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
    <section className="my-8 rounded-lg border border-line bg-surface p-5">
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
          className="inline-flex items-center gap-1 rounded-md border border-line bg-surface-2 text-fg-muted hover:text-fg hover:border-line-strong h-8 px-3 text-xs font-medium transition-colors"
        >
          Record payment
          <ArrowUpRight className="h-3 w-3" />
        </Link>
      </div>

      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-px rounded-md border border-line bg-line overflow-hidden mb-5">
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
        <div className="overflow-x-auto rounded-md border border-line">
          <table className="w-full min-w-[480px]">
            <thead className="text-[10px] uppercase tracking-[0.14em] text-fg-subtle border-b border-line">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Date</th>
                <th className="px-3 py-2 text-left font-medium">Method</th>
                <th className="px-3 py-2 text-right font-medium">Amount</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
                <th className="px-3 py-2 text-left font-medium">Reference</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr
                  key={p.id}
                  className="border-b border-line/40 last:border-b-0 text-xs"
                >
                  <td className="px-3 py-2 font-mono tabular-nums whitespace-nowrap">
                    {formatDate(p.paidAt)}
                  </td>
                  <td className="px-3 py-2 text-fg-muted">
                    {p.method.charAt(0).toUpperCase() + p.method.slice(1)}
                  </td>
                  <td className="px-3 py-2 font-mono tabular-nums text-right whitespace-nowrap">
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
          "mt-1 font-mono tabular-nums tracking-tight text-base",
          accent ? "text-gold" : muted ? "text-fg-subtle" : "text-fg",
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
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 text-emerald-300 ring-1 ring-inset ring-emerald-500/30 px-1.5 py-px text-[9px] font-medium uppercase tracking-wider">
        Confirmed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 text-amber-300 ring-1 ring-inset ring-amber-500/30 px-1.5 py-px text-[9px] font-medium uppercase tracking-wider">
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
