import type { Metadata } from "next";
import Link from "next/link";
import { requireTravelGuardian } from "@/travel/authz";
import {
  getTravelInvoiceScheduleForGuardian,
  listTravelInvoicesForGuardian,
  listTravelPaymentMethodsForGuardian,
  type PortalInstallment,
} from "@/travel/portal-data";
import {
  enrollInMonthlyPlan,
  payDeposit,
  payInFull,
  startCardSetup,
} from "./actions";

export const metadata: Metadata = {
  title: "Billing — PFA Travel",
};

// Block 4c → 4b-2-c — the parent MONEY surface. A signed-in travel GUARDIAN sees
// their saved cards + their own invoices, and per invoice can pay the deposit, set
// up the fixed monthly autopay plan, or pay the remaining balance in full — with
// the installment schedule shown once a plan exists. The whole billing engine
// (vault, off-session charging, cron, plan creation) already exists; this only
// wires it into UI + thin reads/actions.
//
// GUARD: requireTravelGuardian() — the SAME guard the portal home + register use
// — bounces any non-guardian (facility admin / no session) to /travel/signin, so
// the body only renders for an authenticated parent. Rendered inside the travel
// layout (near-black masthead + gold rule) at max-w-5xl.
//
// Banners from searchParams (payment is async via webhook — a paid banner says the
// balance is PROCESSING, never that it's already zero): ?paid=1, ?card=1 (card
// saved), ?planned=1 (monthly plan set up), ?canceled=1, ?error=<code>.
//
// Skin: elevated travel skin — facility tokens, SHARP rounded-md, flat (no
// shadow), 1px border-line, gold as accent only, tracked-uppercase micro-labels.

type SearchParams = Promise<{
  paid?: string;
  card?: string;
  planned?: string;
  canceled?: string;
  error?: string;
}>;

// Friendly copy for each engine / action error code. Covers startDepositCheckout,
// startBalanceCheckout, startAddCard AND createMonthlyPlanForInvoice codes.
const ERROR_COPY: Record<string, string> = {
  not_payable: "That invoice can't be paid right now.",
  not_found: "Invoice not found.",
  not_configured: "Payments are temporarily unavailable — please try again shortly.",
  stripe_error: "Payments are temporarily unavailable — please try again shortly.",
  no_guardian: "Please sign in again.",
  rate: "Please wait a moment and try again.",
  // Monthly-plan (createMonthlyPlanForInvoice) codes.
  no_monthly_amount:
    "A monthly plan isn't available for this invoice. You can still pay the deposit or the balance in full.",
  already_planned: "A monthly plan is already set up for this invoice.",
  no_default_card:
    "Add a card on file first — autopay needs a saved card to charge each month.",
  // Generic fallback code emitted by enrollInMonthlyPlan's unexpected-error path.
  "1": "Something went wrong — please try again.",
};

// Format cents → "$1,234.00" for DISPLAY only.
function formatUsd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

// Format a due date readably (e.g. "Aug 9, 2026"); "—" when absent.
function formatDueDate(date: Date | null): string {
  if (!date) return "—";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// Status → { label, tone } for the badge. paid=green, partial/pending/scheduled
// =gold, overdue=danger, void/refunded=muted. Unknown statuses fall back to muted.
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
    case "overdue":
      return {
        label: "Overdue",
        className: "border-danger/30 bg-danger/10 text-danger",
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
  const { paid, card, planned, canceled, error } = await searchParams;

  const [invoices, paymentMethods] = await Promise.all([
    listTravelInvoicesForGuardian(guardian.id),
    listTravelPaymentMethodsForGuardian(guardian.id),
  ]);
  const hasSavedCard = paymentMethods.length > 0;

  // Pull the installment schedule for every invoice that already has a plan (one
  // scoped, IDOR-safe read each). Keyed by invoice id for the render below.
  const schedules = new Map<string, PortalInstallment[] | null>();
  await Promise.all(
    invoices
      .filter((inv) => inv.hasPlan)
      .map(async (inv) => {
        const rows = await getTravelInvoiceScheduleForGuardian(
          guardian.id,
          inv.id,
        );
        schedules.set(inv.id, rows);
      }),
  );

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
      {card ? (
        <p
          role="status"
          className="mt-6 rounded-md border border-success/30 bg-success/10 px-4 py-3 text-sm text-success"
        >
          Card saved — autopay is ready.
        </p>
      ) : null}
      {planned ? (
        <p
          role="status"
          className="mt-6 rounded-md border border-success/30 bg-success/10 px-4 py-3 text-sm text-success"
        >
          Monthly plan set up — we&apos;ll auto-charge your card on the schedule
          below.
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

      {/* ── Payment methods ─────────────────────────────────────────────── */}
      <div className="mt-8">
        <h2 className="text-[11px] uppercase tracking-[0.18em] font-semibold text-fg-subtle">
          Payment Methods
        </h2>
        <div className="mt-2 h-px w-full bg-line" />
      </div>

      <div className="mt-6 rounded-md border border-line bg-surface p-5">
        {paymentMethods.length === 0 ? (
          <p className="text-sm text-fg-muted">
            No card on file yet — add one to enable autopay.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {paymentMethods.map((pm) => (
              <li
                key={pm.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
              >
                <span className="text-sm font-medium text-fg">
                  {(pm.brand ?? "Card").toUpperCase()} ···· {pm.last4 ?? "••••"}
                  {pm.expMonth && pm.expYear ? (
                    <span className="text-fg-muted">
                      {" · exp "}
                      {String(pm.expMonth).padStart(2, "0")}/
                      {String(pm.expYear).slice(-2)}
                    </span>
                  ) : null}
                </span>
                {pm.isDefault ? (
                  <span className="inline-flex items-center rounded-md border border-yellow/50 bg-yellow/10 px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] font-semibold text-gold">
                    Default
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        <form action={startCardSetup} className="mt-4">
          <button
            type="submit"
            className="rounded-md border border-line bg-surface h-10 px-4 inline-flex items-center text-sm font-semibold text-fg transition-colors hover:bg-page focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40"
          >
            Add a card
          </button>
        </form>
      </div>

      {/* ── Invoices ────────────────────────────────────────────────────── */}
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
            const schedule = invoice.hasPlan
              ? (schedules.get(invoice.id) ?? null)
              : null;
            // The monthly-plan button shows only when the invoice is payable, no
            // plan exists yet, AND the product carries an operator monthly amount.
            const canOfferPlan =
              invoice.isPayable &&
              !invoice.hasPlan &&
              invoice.monthlyInstallmentCents != null &&
              invoice.monthlyInstallmentCents > 0;
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

                {/* Payable actions: deposit · monthly plan · pay-in-full. */}
                {invoice.isPayable ? (
                  <div className="mt-4 flex flex-wrap gap-3">
                    <form action={payDeposit}>
                      <input
                        type="hidden"
                        name="invoiceId"
                        value={invoice.id}
                      />
                      <button
                        type="submit"
                        className="rounded-md border border-yellow/50 bg-yellow/10 h-10 px-4 inline-flex items-center text-sm font-semibold text-gold transition-colors hover:bg-yellow/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40"
                      >
                        Pay deposit
                      </button>
                    </form>

                    {/* Monthly plan — only when offerable AND no plan yet. If the
                        guardian has no saved card, autopay is gated: show a
                        disabled control pointing them to add a card first. */}
                    {canOfferPlan ? (
                      hasSavedCard ? (
                        <form action={enrollInMonthlyPlan}>
                          <input
                            type="hidden"
                            name="invoiceId"
                            value={invoice.id}
                          />
                          <button
                            type="submit"
                            className="rounded-md border border-line bg-surface h-10 px-4 inline-flex items-center text-sm font-semibold text-fg transition-colors hover:bg-page focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40"
                          >
                            Set up monthly plan
                          </button>
                        </form>
                      ) : (
                        <span
                          title="Add a card on file first — autopay needs a saved card."
                          className="rounded-md border border-line bg-surface-2 h-10 px-4 inline-flex items-center text-sm font-medium text-fg-subtle cursor-not-allowed"
                        >
                          Set up monthly plan · add a card first
                        </span>
                      )
                    ) : null}

                    <form action={payInFull}>
                      <input
                        type="hidden"
                        name="invoiceId"
                        value={invoice.id}
                      />
                      <button
                        type="submit"
                        className="rounded-md border border-line bg-surface h-10 px-4 inline-flex items-center text-sm font-semibold text-fg transition-colors hover:bg-page focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40"
                      >
                        Pay remaining balance
                      </button>
                    </form>
                  </div>
                ) : invoice.status === "paid" ? (
                  <p className="mt-4 text-sm font-medium text-success">
                    Paid in full — nothing due.
                  </p>
                ) : null}

                {/* Installment schedule — shown once a plan exists. */}
                {schedule && schedule.length > 0 ? (
                  <div className="mt-5">
                    <h4 className="text-[10px] uppercase tracking-[0.14em] font-semibold text-fg-subtle">
                      Monthly plan
                    </h4>
                    <div className="mt-2 overflow-x-auto rounded-md border border-line bg-page">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-line text-left">
                            <th className="px-4 py-2 text-[10px] uppercase tracking-[0.14em] font-semibold text-fg-subtle">
                              Payment
                            </th>
                            <th className="px-4 py-2 text-[10px] uppercase tracking-[0.14em] font-semibold text-fg-subtle">
                              Due
                            </th>
                            <th className="px-4 py-2 text-[10px] uppercase tracking-[0.14em] font-semibold text-fg-subtle">
                              Amount
                            </th>
                            <th className="px-4 py-2 text-[10px] uppercase tracking-[0.14em] font-semibold text-fg-subtle">
                              Status
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {schedule.map((inst) => {
                            const instBadge = statusBadge(inst.status);
                            return (
                              <tr
                                key={inst.seq}
                                className="border-b border-line last:border-b-0"
                              >
                                <td className="px-4 py-2 font-medium text-fg">
                                  Payment {inst.seq} of {schedule.length}
                                </td>
                                <td className="px-4 py-2 text-fg-muted">
                                  {formatDueDate(inst.dueDate)}
                                </td>
                                <td className="px-4 py-2 font-medium text-fg">
                                  {formatUsd(inst.amountCents)}
                                </td>
                                <td className="px-4 py-2">
                                  <span
                                    className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] font-semibold ${instBadge.className}`}
                                  >
                                    {instBadge.label}
                                  </span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
