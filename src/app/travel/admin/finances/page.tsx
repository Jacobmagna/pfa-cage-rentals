import Link from "next/link";
import { requireTravelAccess } from "@/travel/authz";
import {
  getTravelFinancialSummary,
  getTravelOnTimeCollection,
  getTravelRevenueByFamily,
  getTravelRevenueByProduct,
  getTravelRevenueByTeam,
  type TravelOnTimeCollection,
} from "@/travel/reporting";
import { parseReportPeriod } from "@/travel/reporting.logic";

// Block 5a — the operator FINANCES dashboard (/travel/admin/finances). Guarded
// operator-only (requireTravelAccess redirects a guardian / no session). A
// READ-ONLY reporting spine over money already collected to the single travel
// account: top-line summary, an on-time-collection KPI, and net-by product /
// team / family breakdowns. A GET period bar scopes everything by ?from=&to=.
// NO write actions, NO forms that POST, NO Stripe — settlement/commission is a
// later task.
//
// Skin: elevated travel — flat rounded-md, hairline border on bg-surface,
// credential uppercase micro-labels, gold accent restrained. Amounts in Geist
// Mono (font-mono tnum tabular-nums), right-aligned. Facility tokens only.

type SearchParams = Promise<{ from?: string; to?: string }>;

const LABEL =
  "block text-[11px] uppercase tracking-wider font-semibold text-fg-subtle";

const TH =
  "px-4 py-2.5 text-[11px] uppercase tracking-wider font-semibold text-fg-subtle";

const MONEY = "font-mono tnum tabular-nums whitespace-nowrap";

// Format integer cents → "$1,234.00".
function formatUsd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

// A top-line summary figure card.
function SummaryCard({
  label,
  value,
  tone,
  caption,
}: {
  label: string;
  value: string;
  tone?: string;
  caption?: string;
}) {
  return (
    <div className="rounded-md border border-line bg-surface p-4">
      <p className={LABEL}>{label}</p>
      <p className={`mt-1.5 text-2xl font-bold ${MONEY} ${tone ?? "text-fg"}`}>
        {value}
      </p>
      {caption ? (
        <p className="mt-1 text-[11px] text-fg-subtle">{caption}</p>
      ) : null}
    </div>
  );
}

// Tier → badge tone + copy. full → gold accent; half → muted-gold; none → muted.
function tierBadge(tier: TravelOnTimeCollection["tier"]): {
  tone: string;
  copy: string;
} {
  if (tier === "full") {
    return {
      tone: "border-yellow/30 bg-yellow/10 text-gold",
      copy: "Full bonus tier",
    };
  }
  if (tier === "half") {
    return {
      tone: "border-line bg-surface-2 text-fg-muted",
      copy: "Half bonus tier",
    };
  }
  return {
    tone: "border-line bg-surface-2 text-fg-subtle",
    copy: "No bonus tier",
  };
}

function OnTimeCard({ onTime }: { onTime: TravelOnTimeCollection }) {
  const badge = tierBadge(onTime.tier);
  return (
    <div className="rounded-md border border-line bg-surface p-4">
      <p className={LABEL}>On-time collections</p>
      {onTime.ratePct === null ? (
        <>
          <p className="mt-1.5 text-2xl font-bold text-fg-subtle">—</p>
          <p className="mt-1 text-[11px] text-fg-subtle">
            No installments due in this period.
          </p>
        </>
      ) : (
        <>
          <div className="mt-1.5 flex items-baseline gap-2">
            <p className={`text-2xl font-bold ${MONEY} text-fg`}>
              {onTime.ratePct}%
            </p>
            <span
              className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wider font-semibold ${badge.tone}`}
            >
              {badge.copy}
            </span>
          </div>
          <p className="mt-1 text-[11px] text-fg-subtle">
            {onTime.onTimeCount} of {onTime.dueCount} due paid on time — bonus KPI
            (payout engine is a later addition).
          </p>
        </>
      )}
    </div>
  );
}

// A reusable breakdown table. Rows are already sorted netCents desc.
function BreakdownTable({
  title,
  firstColLabel,
  rows,
  emptyLabel,
}: {
  title: string;
  firstColLabel: string;
  rows: {
    key: string;
    name: string;
    sub?: string | null;
    collectedCents: number;
    refundedCents: number;
    netCents: number;
    countLabel: string;
  }[];
  emptyLabel: string;
}) {
  return (
    <section className="overflow-hidden rounded-md border border-line bg-surface">
      <div className="border-b border-line px-4 py-3">
        <h2 className="text-sm font-bold tracking-tight text-fg">{title}</h2>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-8 text-center">
          <p className="text-sm text-fg-muted">{emptyLabel}</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-line text-left">
                <th className={TH}>{firstColLabel}</th>
                <th className={`${TH} text-right`}>Collected</th>
                <th className={`${TH} text-right`}>Refunded</th>
                <th className={`${TH} text-right`}>Net</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.key}
                  className="border-b border-line last:border-0 align-top"
                >
                  <td className="px-4 py-3">
                    <p className="font-medium text-fg">{r.name}</p>
                    {r.sub ? (
                      <p className="text-[11px] text-fg-subtle">{r.sub}</p>
                    ) : null}
                    <p className="text-[11px] text-fg-subtle">{r.countLabel}</p>
                  </td>
                  <td
                    className={`px-4 py-3 text-right ${MONEY} text-fg-muted`}
                  >
                    {formatUsd(r.collectedCents)}
                  </td>
                  <td
                    className={`px-4 py-3 text-right ${MONEY} text-fg-muted`}
                  >
                    {formatUsd(r.refundedCents)}
                  </td>
                  <td
                    className={`px-4 py-3 text-right font-semibold ${MONEY} text-fg`}
                  >
                    {formatUsd(r.netCents)}
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

// Period selector: a small GET form (mirrors the Northstar reconciliation
// PeriodBar). Two native date inputs default to empty = all-time; Apply
// resubmits; an "All time" reset clears the bounds.
function PeriodBar({ from, to }: { from: string; to: string }) {
  const input =
    "h-10 w-full rounded-md border border-line bg-page px-3 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40";
  return (
    <form
      method="GET"
      action="/travel/admin/finances"
      className="flex flex-wrap items-end gap-3 rounded-md border border-line bg-surface p-4"
    >
      <label className="flex flex-col gap-1">
        <span className={LABEL}>From</span>
        <input type="date" name="from" defaultValue={from} className={input} />
      </label>
      <label className="flex flex-col gap-1">
        <span className={LABEL}>To</span>
        <input type="date" name="to" defaultValue={to} className={input} />
      </label>
      <button
        type="submit"
        className="inline-flex h-10 items-center rounded-md bg-yellow px-5 text-sm font-semibold text-gold-ink transition-colors hover:bg-gold-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40"
      >
        Apply
      </button>
      {from || to ? (
        <Link
          href="/travel/admin/finances"
          className="inline-flex h-10 items-center text-sm text-fg-muted underline-offset-2 transition-colors hover:text-fg hover:underline"
        >
          All time
        </Link>
      ) : null}
    </form>
  );
}

export default async function TravelFinancesPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requireTravelAccess();

  const { from, to } = await searchParams;
  const period = { from, to };
  // Re-parse so the header shows the SAME normalized label the reads used
  // (an invalid ?from= silently becomes all-time).
  const parsed = parseReportPeriod(from, to);

  const [summary, byProduct, byTeam, byFamily, onTime] = await Promise.all([
    getTravelFinancialSummary(period),
    getTravelRevenueByProduct(period),
    getTravelRevenueByTeam(period),
    getTravelRevenueByFamily(period),
    getTravelOnTimeCollection(period),
  ]);

  const nothingYet =
    summary.succeededPaymentCount === 0 && summary.billedCents === 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <p className="text-[10px] uppercase tracking-[0.2em] text-fg-subtle">
          PFA Travel / Operator
        </p>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h1 className="text-2xl font-bold tracking-tight text-fg">Finances</h1>
          <p className="text-[11px] uppercase tracking-wider text-fg-subtle">
            Period:{" "}
            <span className="font-mono normal-case tracking-normal text-fg-muted">
              {parsed.label}
            </span>
          </p>
        </div>
        <p className="text-xs text-fg-muted">
          Reporting only — reflects money collected to the single travel account.
          Operator settlement/commission is a later addition.
        </p>
      </div>

      <PeriodBar from={from ?? ""} to={to ?? ""} />

      {nothingYet ? (
        <div className="rounded-md border border-line bg-surface p-8 text-center">
          <p className="text-sm text-fg-muted">
            No money activity yet in this period. Collected payments and billed
            invoices appear here as they post — widen the period to see all-time
            activity.
          </p>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <SummaryCard
          label="Collected"
          value={formatUsd(summary.collectedCents)}
          tone="text-success"
          caption={`${summary.succeededPaymentCount} succeeded payment${
            summary.succeededPaymentCount === 1 ? "" : "s"
          }`}
        />
        <SummaryCard
          label="Refunded"
          value={formatUsd(summary.refundedCents)}
          tone={summary.refundedCents > 0 ? "text-danger" : "text-fg"}
          caption={`${summary.refundCount} refund${
            summary.refundCount === 1 ? "" : "s"
          }`}
        />
        <SummaryCard
          label="Net collected"
          value={formatUsd(summary.netCollectedCents)}
          caption="Collected − refunded"
        />
        <SummaryCard
          label="Billed"
          value={formatUsd(summary.billedCents)}
          caption="Non-void invoices in period"
        />
        <SummaryCard
          label="Outstanding (AR)"
          value={formatUsd(summary.outstandingCents)}
          tone={summary.outstandingCents > 0 ? "text-gold" : "text-fg"}
          caption="Owed right now — point-in-time"
        />
        <OnTimeCard onTime={onTime} />
      </div>

      <BreakdownTable
        title="Net revenue by product"
        firstColLabel="Product"
        emptyLabel="No product revenue in this period."
        rows={byProduct.map((r) => ({
          key: r.productId ?? "__none__",
          name: r.productName ?? "Unknown / removed product",
          sub: r.teamName,
          collectedCents: r.collectedCents,
          refundedCents: r.refundedCents,
          netCents: r.netCents,
          countLabel: `${r.invoiceCount} invoice${
            r.invoiceCount === 1 ? "" : "s"
          }`,
        }))}
      />

      <BreakdownTable
        title="Net revenue by team"
        firstColLabel="Team"
        emptyLabel="No team revenue in this period."
        rows={byTeam.map((r) => ({
          key: r.teamId ?? "__none__",
          name: r.teamName,
          sub: null,
          collectedCents: r.collectedCents,
          refundedCents: r.refundedCents,
          netCents: r.netCents,
          countLabel: `${r.invoiceCount} invoice${
            r.invoiceCount === 1 ? "" : "s"
          }`,
        }))}
      />

      <BreakdownTable
        title="Net revenue by family"
        firstColLabel="Family"
        emptyLabel="No family revenue in this period."
        rows={byFamily.map((r) => ({
          key: r.guardianId ?? "__none__",
          name: r.guardianName ?? "Unknown / removed guardian",
          sub: null,
          collectedCents: r.collectedCents,
          // net = collected − refunded, so refunded is the exact difference.
          refundedCents: r.collectedCents - r.netCents,
          netCents: r.netCents,
          countLabel: `Outstanding ${formatUsd(r.outstandingCents)}`,
        }))}
      />
    </div>
  );
}
