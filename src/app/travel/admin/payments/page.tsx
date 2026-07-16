import { requireTravelAccess } from "@/travel/authz";
import {
  listTravelPaymentsForOperator,
  type OperatorPayment,
} from "@/travel/catalog";
import { issueRefund } from "./actions";

// Block 4d — the operator PAYMENTS + REFUNDS surface (/travel/admin/payments).
// Guarded operator-only (requireTravelAccess redirects a guardian / no session —
// refunds are NEVER exposed to a guardian). Lists travel payments (guardian,
// product, amount, channel, status, paid date, refunded-so-far). Each succeeded
// payment with a refundable remainder gets an inline refund form over the
// already-built refundPayment engine (wired by ./actions.ts); a fully-refunded
// payment shows a "Refunded" badge and no form. ?refunded=1 success banner +
// friendly copy for every issueRefund / refundPayment error code.
//
// Skin: elevated travel — sharp rounded-md, flat, hairline border on bg-surface,
// credential micro-labels, gold accent restrained, formatUsd for money. Facility
// tokens only.

type SearchParams = Promise<{
  refunded?: string;
  error?: string;
}>;

const LABEL =
  "block text-[11px] uppercase tracking-wider font-semibold text-fg-subtle";

// Friendly copy for every ?error= code the refund action can bounce back.
const ERROR_COPY: Record<string, string> = {
  rate: "Too many attempts — please wait a moment and try again.",
  not_found: "That payment could not be found.",
  not_refundable:
    "That payment can't be refunded (only a succeeded payment can be).",
  amount_invalid: "Enter a valid refund amount greater than $0.",
  amount_exceeds:
    "That amount is more than the remaining refundable balance on this payment.",
  not_configured: "Payments aren't configured yet — no refund was issued.",
  stripe_error:
    "The payment processor rejected the refund — nothing was refunded. Try again.",
  "1": "Something went wrong — no refund was issued. Please try again.",
};

// Format integer cents → "$1,234.00".
function formatUsd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

// Payment status → badge tone. succeeded → success green; refunded → muted;
// failed → danger; pending → gold (in-flight).
function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "succeeded"
      ? "border-emerald/30 bg-emerald/10 text-emerald"
      : status === "refunded"
        ? "border-line bg-surface-2 text-fg-subtle"
        : status === "failed"
          ? "border-danger/30 bg-danger/10 text-danger"
          : "border-yellow/30 bg-yellow/10 text-gold";
  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wider font-semibold ${tone}`}
    >
      {status}
    </span>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-0.5">
      <p className={LABEL}>{label}</p>
      <p className="text-sm text-fg">{value}</p>
    </div>
  );
}

// Shared field classes (mirror the product / register forms).
const INPUT =
  "w-full rounded-md border border-line bg-page h-10 px-3 text-sm text-fg placeholder:text-fg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40";

function PaymentCard({ payment }: { payment: OperatorPayment }) {
  const paid = payment.paidAt
    ? payment.paidAt.toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : "—";

  // A succeeded payment with a positive remainder can still be refunded (in full
  // or partially); default the amount input to the remaining refundable amount.
  const canRefund =
    payment.status === "succeeded" && payment.refundableCents > 0;
  // A succeeded payment with some (but not all) refunded → partial history shown.
  const fullyRefunded =
    payment.status === "refunded" ||
    (payment.status === "succeeded" &&
      payment.refundedCents > 0 &&
      payment.refundableCents === 0);

  return (
    <article className="rounded-md border border-line bg-surface p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-0.5">
          <h2 className="text-lg font-bold tracking-tight text-fg">
            {payment.guardianName ?? "—"}
          </h2>
          <p className="text-xs text-fg-muted">{payment.productName ?? "—"}</p>
        </div>
        <StatusBadge status={payment.status} />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 border-t border-line pt-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Email" value={payment.guardianEmail ?? "—"} />
        <Field label="Channel" value={payment.channel} />
        <Field label="Paid" value={paid} />
        <Field label="Amount" value={formatUsd(payment.amountCents)} />
        <Field
          label="Refunded so far"
          value={formatUsd(payment.refundedCents)}
        />
        <Field
          label="Refundable"
          value={formatUsd(payment.refundableCents)}
        />
      </div>

      {canRefund ? (
        <form
          action={issueRefund}
          className="mt-4 grid grid-cols-1 gap-3 border-t border-line pt-4 sm:grid-cols-[minmax(0,160px)_1fr_auto] sm:items-end"
        >
          <input type="hidden" name="paymentId" value={payment.id} />
          <div className="space-y-1.5">
            <label
              htmlFor={`amount-${payment.id}`}
              className={LABEL}
            >
              Refund amount
            </label>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-fg-subtle">
                $
              </span>
              <input
                id={`amount-${payment.id}`}
                name="amountDollars"
                inputMode="decimal"
                required
                defaultValue={(payment.refundableCents / 100).toFixed(2)}
                className={`${INPUT} pl-7`}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`reason-${payment.id}`} className={LABEL}>
              Reason (optional)
            </label>
            <input
              id={`reason-${payment.id}`}
              name="reason"
              placeholder="e.g. duplicate charge"
              className={INPUT}
            />
          </div>
          <button
            type="submit"
            className="rounded-md bg-yellow text-gold-ink h-10 px-5 text-sm font-semibold transition-colors hover:bg-gold-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40"
          >
            Issue refund
          </button>
        </form>
      ) : fullyRefunded ? (
        <div className="mt-4 border-t border-line pt-4">
          <span className="inline-flex items-center rounded-md border border-line bg-surface-2 px-2 py-0.5 text-[10px] uppercase tracking-wider font-semibold text-fg-subtle">
            Fully refunded
          </span>
        </div>
      ) : null}
    </article>
  );
}

export default async function TravelPaymentsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requireTravelAccess();

  const { refunded, error } = await searchParams;
  const errorMessage = error ? (ERROR_COPY[error] ?? ERROR_COPY["1"]) : null;

  const payments = await listTravelPaymentsForOperator();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <p className="text-[10px] uppercase tracking-[0.2em] text-fg-subtle">
          PFA Travel / Operator
        </p>
        <h1 className="text-2xl font-bold tracking-tight text-fg">
          Payments &amp; Refunds
        </h1>
      </div>

      {refunded ? (
        <p
          role="status"
          className="rounded-md border border-emerald/30 bg-emerald/10 px-3 py-2 text-sm text-emerald"
        >
          Refund issued.
        </p>
      ) : null}

      {errorMessage ? (
        <p
          role="alert"
          className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          {errorMessage}
        </p>
      ) : null}

      {payments.length === 0 ? (
        <div className="rounded-md border border-line bg-surface p-8 text-center">
          <p className="text-sm text-fg-muted">No payments yet.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {payments.map((payment) => (
            <PaymentCard key={payment.id} payment={payment} />
          ))}
        </div>
      )}
    </div>
  );
}
