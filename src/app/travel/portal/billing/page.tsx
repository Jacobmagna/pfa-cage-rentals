import type { Metadata } from "next";
import Link from "next/link";
import { requireTravelGuardian } from "@/travel/authz";
import { listTravelInvoicesForGuardian } from "@/travel/portal-data";
import { payDeposit } from "./actions";

export const metadata: Metadata = {
  title: "Billing — PFA Travel",
};

// Block 4c — the parent checkout screen. A signed-in travel GUARDIAN sees their
// own invoices (what they owe) and pays the deposit via Stripe Hosted Checkout,
// wiring the Block-4b-1 startDepositCheckout through ./actions.ts.
//
// GUARD: requireTravelGuardian() — the SAME guard the portal home + register use
// — bounces any non-guardian (facility admin / no session) to /travel/signin, so
// the body only renders for an authenticated parent. Rendered inside the travel
// layout (near-black masthead + gold rule) at max-w-5xl.
//
// Banners from searchParams: ?paid=1 (payment is async via webhook — say it's
// PROCESSING, never claim the balance is already zero), ?canceled=1, ?error=.
//
// Skin: elevated travel skin — facility tokens, SHARP rounded-md, flat (no
// shadow), 1px border-line, gold as accent only, tracked-uppercase micro-labels.

type SearchParams = Promise<{
  paid?: string;
  canceled?: string;
  error?: string;
}>;

// Friendly copy for each StartDepositCheckout / action error code.
const ERROR_COPY: Record<string, string> = {
  not_payable: "That invoice can't be paid right now.",
  not_found: "Invoice not found.",
  not_configured: "Payments are temporarily unavailable — please try again shortly.",
  stripe_error: "Payments are temporarily unavailable — please try again shortly.",
  no_guardian: "Please sign in again.",
  rate: "Please wait a moment and try again.",
};

// Format cents → "$1,234.00" for DISPLAY only.
function formatUsd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

// Status → { label, tone } for the badge. paid=green, partial/pending/scheduled
// =gold, void/refunded=muted. Unknown statuses fall back to muted.
function statusBadge(status: string): { label: string; className: string } {
  switch (status) {
    case "paid":
      return {
        label: "Paid",
        className:
          "border-success/30 bg-success/10 text-success",
      };
    case "partial":
      return {
        label: "Partially paid",
        className: "border-yellow/40 bg-yellow/10 text-gold",
      };
    case "pending":
      return {
        label: "Due",
        className: "border-yellow/40 bg-yellow/10 text-gold",
      };
    case "scheduled":
      return {
        label: "Scheduled",
        className: "border-yellow/40 bg-yellow/10 text-gold",
      };
    case "refunded":
      return {
        label: "Refunded",
        className: "border-line bg-surface-2 text-fg-subtle",
      };
    case "void":
      return {
        label: "Void",
        className: "border-line bg-surface-2 text-fg-subtle",
      };
    default:
      return {
        label: status,
        className: "border-line bg-surface-2 text-fg-subtle",
      };
  }
}

export default async function TravelBilling({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const guardian = await requireTravelGuardian();
  const { paid, canceled, error } = await searchParams;

  const invoices = await listTravelInvoicesForGuardian(guardian.id);

  const errorMessage = error ? (ERROR_COPY[error] ?? null) : null;

  return (
    <div className="flex flex-1 flex-col">
      {/* Header row: title + a restrained back-to-portal link. */}
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold tracking-tight text-fg">Billing</h1>
        <Link
          href="/travel/portal"
          className="rounded-md border border-line bg-surface h-9 px-3 inline-flex items-center text-sm font-medium text-fg transition-colors hover:bg-page focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40"
        >
          Back to portal
        </Link>
      </div>

      {/* Banners — payment is async (webhook), so the paid banner says the
          balance is UPDATING/processing, never that it's already zero. */}
      {paid ? (
        <p
          role="status"
          className="mt-6 rounded-md border border-success/30 bg-success/10 px-4 py-3 text-sm text-success"
        >
          Payment received — we&apos;re updating your balance. Your spot is
          locked.
        </p>
      ) : null}
      {canceled ? (
        <p
          role="status"
          className="mt-6 rounded-md border border-yellow/40 bg-yellow/10 px-4 py-3 text-sm text-gold"
        >
          Checkout canceled — you can try again anytime.
        </p>
      ) : null}
      {errorMessage ? (
        <p
          role="alert"
          className="mt-6 rounded-md border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger"
        >
          {errorMessage}
        </p>
      ) : null}

      {/* Section label: tracked-uppercase micro-label + a hairline rule. */}
      <div className="mt-8">
        <h2 className="text-[11px] uppercase tracking-[0.18em] font-semibold text-fg-subtle">
          Your Invoices
        </h2>
        <div className="mt-2 h-px w-full bg-line" />
      </div>

      {invoices.length === 0 ? (
        // Intentional, on-brand empty panel.
        <div className="mt-6 rounded-md border border-line bg-surface-2 p-8 text-center">
          <p className="text-base font-semibold text-fg">No invoices yet</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-fg-muted">
            Once you register an athlete for a season your dues will show here.
          </p>
        </div>
      ) : (
        <div className="mt-6 space-y-4">
          {invoices.map((invoice) => {
            const badge = statusBadge(invoice.status);
            return (
              <article
                key={invoice.id}
                className="rounded-md border border-line border-l-2 border-l-yellow bg-surface p-5"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="font-semibold text-fg">
                      {invoice.productName ?? "PFA Travel dues"}
                    </h3>
                    {invoice.athleteName ? (
                      <p className="mt-0.5 text-sm text-fg-muted">
                        {invoice.athleteName}
                      </p>
                    ) : null}
                  </div>
                  <span
                    className={`inline-flex items-center rounded-md border px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] font-semibold ${badge.className}`}
                  >
                    {badge.label}
                  </span>
                </div>

                {/* Total + balance owed — the money read, in a hairline panel. */}
                <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-2 rounded-md border border-line bg-page px-4 py-3">
                  <div>
                    <dt className="text-[10px] uppercase tracking-[0.14em] font-semibold text-fg-subtle">
                      Total
                    </dt>
                    <dd className="mt-0.5 text-base font-bold text-fg">
                      {formatUsd(invoice.totalCents)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[10px] uppercase tracking-[0.14em] font-semibold text-fg-subtle">
                      Balance owed
                    </dt>
                    <dd className="mt-0.5 text-base font-bold text-fg">
                      {formatUsd(invoice.balanceCents)}
                    </dd>
                  </div>
                </dl>

                {invoice.isPayable ? (
                  <form action={payDeposit} className="mt-4">
                    <input type="hidden" name="invoiceId" value={invoice.id} />
                    <button
                      type="submit"
                      className="rounded-md border border-yellow/50 bg-yellow/10 h-10 px-4 inline-flex items-center text-sm font-semibold text-gold transition-colors hover:bg-yellow/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40"
                    >
                      Pay deposit
                    </button>
                  </form>
                ) : invoice.status === "paid" ? (
                  <p className="mt-4 text-sm font-medium text-success">
                    Paid in full — nothing due.
                  </p>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
