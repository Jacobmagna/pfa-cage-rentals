"use client";

import {
  useActionState,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Check,
  CheckCircle2,
  ClipboardCopy,
  ExternalLink,
  X,
} from "lucide-react";
import {
  submitOwnPaymentFormAction,
  type CoachPaymentActionResult,
} from "../form-actions";
import { PFA_TIMEZONE, formatPfaDate } from "@/lib/timezone";

// Coach-facing payments client island. Renders the balance summary,
// rentals list, payment history, and the Pay / Mark-paid buttons +
// the "I just paid" pending dialog.
//
// Submission flow:
//   1. Coach taps "Pay via Venmo" → opens venmo.com (mobile: app deep
//      link) with PFA pre-filled. The browser leaves the app.
//   2. They come back, tap "I just paid" → modal opens pre-filled
//      with their current balance + today's date.
//   3. Submit creates a `pending` row. Dad confirms on his admin
//      surface; coach sees a green badge transition then.
//
// Why optional Mark-paid for Zelle separately: Venmo has a deep link;
// Zelle requires their bank app. The Zelle button just copies the
// contact + opens the same "I just paid" modal.

const INITIAL_STATE: CoachPaymentActionResult = { ok: true, submittedAt: 0 };

export type RentalRow = {
  id: string;
  resourceName: string;
  resourceType: string;
  startAt: Date;
  endAt: Date;
  note: string | null;
  slots: number;
  ratePerSlotCents: number;
  totalCents: number;
};

export type PaymentHistoryRow = {
  id: string;
  amountCents: number;
  method: "venmo" | "zelle" | "check" | "cash" | "other";
  paidAt: Date;
  reference: string | null;
  note: string | null;
  status: "pending" | "confirmed";
  recordedAt: Date;
};

export function CoachPaymentsClient({
  owedCents,
  paidCents,
  pendingCents,
  balanceCents,
  rentals,
  payments,
  pfaDisplayName,
  pfaVenmoHandle,
  pfaZelleContact,
}: {
  owedCents: number;
  paidCents: number;
  pendingCents: number;
  balanceCents: number;
  rentals: RentalRow[];
  payments: PaymentHistoryRow[];
  pfaDisplayName: string;
  pfaVenmoHandle: string | null;
  pfaZelleContact: string | null;
}) {
  // Effective balance shown to the coach = balance minus pending.
  // Pending payments don't reduce the admin-side balance yet, but for
  // the coach's mental model showing "you still owe X after that
  // pending payment goes through" is clearer than the raw owed-paid.
  const effectivePendingAdjustedCents = balanceCents - pendingCents;

  const [dialogMethod, setDialogMethod] = useState<
    "venmo" | "zelle" | "other" | null
  >(null);
  const closeDialog = () => setDialogMethod(null);

  // Default the dialog's amount to the pending-adjusted balance,
  // clamped to a positive number. If they've over-paid (balance
  // negative), default to 0 so they have to enter something explicit.
  const defaultAmount = Math.max(effectivePendingAdjustedCents, 0);

  return (
    <>
      <BalanceCard
        owedCents={owedCents}
        paidCents={paidCents}
        pendingCents={pendingCents}
        balanceCents={balanceCents}
      />

      <PayCard
        pfaDisplayName={pfaDisplayName}
        pfaVenmoHandle={pfaVenmoHandle}
        pfaZelleContact={pfaZelleContact}
        amountCents={defaultAmount}
        onMarkPaid={setDialogMethod}
      />

      <RentalsList rentals={rentals} />

      <PaymentHistory payments={payments} />

      <MarkPaidDialog
        open={dialogMethod !== null}
        defaultMethod={dialogMethod}
        defaultAmountCents={defaultAmount}
        onClose={closeDialog}
      />
    </>
  );
}

function BalanceCard({
  owedCents,
  paidCents,
  pendingCents,
  balanceCents,
}: {
  owedCents: number;
  paidCents: number;
  pendingCents: number;
  balanceCents: number;
}) {
  const isSettled = balanceCents <= 0;
  return (
    <section className="mb-8" aria-label="Balance summary">
      <div className="rounded-xl border border-line bg-surface p-5 sm:p-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <p className="text-xs uppercase tracking-[0.14em] text-fg-muted">
              Your balance
            </p>
            <p
              className={`mt-2 text-4xl sm:text-5xl font-bold tracking-tight font-mono tabular-nums ${
                isSettled ? "text-emerald-300" : "text-gold"
              }`}
            >
              {isSettled ? "$0.00" : formatDollars(balanceCents)}
            </p>
            <p className="mt-2 text-sm text-fg-muted">
              {isSettled
                ? "You're all settled with PFA."
                : "Outstanding to PFA."}
            </p>
          </div>
        </div>
        <dl className="mt-5 grid grid-cols-3 gap-px rounded-md border border-line bg-line overflow-hidden">
          <SubStat label="Rentals" value={formatDollars(owedCents)} />
          <SubStat label="You've paid" value={formatDollars(paidCents)} />
          <SubStat
            label="Pending"
            value={formatDollars(pendingCents)}
            muted={pendingCents === 0}
          />
        </dl>
      </div>
    </section>
  );
}

function PayCard({
  pfaDisplayName,
  pfaVenmoHandle,
  pfaZelleContact,
  amountCents,
  onMarkPaid,
}: {
  pfaDisplayName: string;
  pfaVenmoHandle: string | null;
  pfaZelleContact: string | null;
  amountCents: number;
  onMarkPaid: (method: "venmo" | "zelle" | "other") => void;
}) {
  if (!pfaVenmoHandle && !pfaZelleContact) {
    return (
      <section className="mb-8" aria-label="Payment instructions">
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-5">
          <p className="text-sm text-amber-200">
            PFA hasn&apos;t set up payment handles yet. Reach out to them
            directly to settle up.
          </p>
        </div>
      </section>
    );
  }

  const amountDollars = (amountCents / 100).toFixed(2);
  const noteText = `PFA cage rentals${amountCents > 0 ? ` $${amountDollars}` : ""}`;

  // Venmo deep link. The browser will open the Venmo app on mobile if
  // installed; otherwise it falls back to venmo.com with the same
  // prefill query string.
  const venmoUrl = pfaVenmoHandle
    ? `https://venmo.com/?txn=pay&audience=private&recipients=${encodeURIComponent(pfaVenmoHandle)}&amount=${encodeURIComponent(amountDollars)}&note=${encodeURIComponent(noteText)}`
    : null;

  return (
    <section className="mb-8" aria-labelledby="pay-heading">
      <h2
        id="pay-heading"
        className="mb-3 text-xs uppercase tracking-[0.14em] text-fg-muted"
      >
        Pay {pfaDisplayName}
      </h2>
      <div className="grid gap-3 sm:grid-cols-2">
        {venmoUrl ? (
          <PayMethodCard
            label="Venmo"
            handle={`@${pfaVenmoHandle}`}
            primaryHref={venmoUrl}
            primaryLabel={`Pay ${amountCents > 0 ? `$${amountDollars} ` : ""}via Venmo`}
            onMarkPaid={() => onMarkPaid("venmo")}
            instructions="Tap to open Venmo with the amount pre-filled. After it goes through, hit 'I just paid' below."
          />
        ) : null}

        {pfaZelleContact ? (
          <PayMethodCard
            label="Zelle"
            handle={pfaZelleContact}
            primaryHref={null}
            primaryLabel="Copy Zelle contact"
            copyValue={pfaZelleContact}
            onMarkPaid={() => onMarkPaid("zelle")}
            instructions="Send through your bank's Zelle, then come back and hit 'I just paid'."
          />
        ) : null}
      </div>
    </section>
  );
}

function PayMethodCard({
  label,
  handle,
  primaryHref,
  primaryLabel,
  copyValue,
  onMarkPaid,
  instructions,
}: {
  label: string;
  handle: string;
  primaryHref: string | null;
  primaryLabel: string;
  copyValue?: string;
  onMarkPaid: () => void;
  instructions: string;
}) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    if (!copyValue) return;
    try {
      await navigator.clipboard.writeText(copyValue);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Silent — fallback is selecting the handle text directly.
    }
  };

  return (
    <div className="rounded-lg border border-line bg-surface p-4 flex flex-col">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <p className="text-sm font-semibold text-fg">{label}</p>
        <span className="font-mono text-xs text-fg-muted">{handle}</span>
      </div>
      <p className="text-xs text-fg-subtle leading-snug mb-4">{instructions}</p>
      <div className="mt-auto flex flex-col gap-2">
        {primaryHref ? (
          <a
            href={primaryHref}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-1.5 rounded-md bg-gold text-gold-ink hover:bg-gold-hover h-10 px-4 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
          >
            <ExternalLink className="h-4 w-4" strokeWidth={2.5} />
            {primaryLabel}
          </a>
        ) : (
          <button
            type="button"
            onClick={onCopy}
            className="inline-flex items-center justify-center gap-1.5 rounded-md bg-gold text-gold-ink hover:bg-gold-hover h-10 px-4 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
          >
            {copied ? (
              <>
                <Check className="h-4 w-4" strokeWidth={2.5} />
                Copied
              </>
            ) : (
              <>
                <ClipboardCopy className="h-4 w-4" strokeWidth={2.5} />
                {primaryLabel}
              </>
            )}
          </button>
        )}
        <button
          type="button"
          onClick={onMarkPaid}
          className="inline-flex items-center justify-center gap-1.5 rounded-md border border-line bg-surface-2 text-fg-muted hover:text-fg hover:border-line-strong h-9 px-4 text-xs font-medium transition-colors"
        >
          I just paid
        </button>
      </div>
    </div>
  );
}

function RentalsList({ rentals }: { rentals: RentalRow[] }) {
  if (rentals.length === 0) {
    return (
      <section className="mb-8" aria-labelledby="rentals-heading">
        <h2
          id="rentals-heading"
          className="mb-3 text-xs uppercase tracking-[0.14em] text-fg-muted"
        >
          Your rentals
        </h2>
        <div className="rounded-lg border border-line/60 bg-surface/40 px-4 py-8 text-center">
          <p className="text-sm text-fg-subtle">No rentals on record yet.</p>
        </div>
      </section>
    );
  }
  return (
    <section className="mb-8" aria-labelledby="rentals-heading">
      <h2
        id="rentals-heading"
        className="mb-3 text-xs uppercase tracking-[0.14em] text-fg-muted"
      >
        Your rentals ({rentals.length})
      </h2>
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-[480px]">
          <thead className="text-[10px] uppercase tracking-[0.14em] text-fg-subtle border-b border-line bg-surface">
            <tr>
              <th className="px-3 py-2 text-left font-medium">When</th>
              <th className="px-3 py-2 text-left font-medium">Resource</th>
              <th className="px-3 py-2 text-right font-medium">Slots</th>
              <th className="px-3 py-2 text-right font-medium">Rate</th>
              <th className="px-3 py-2 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {rentals.map((r) => (
              <tr
                key={r.id}
                className="border-b border-line/40 last:border-b-0 text-xs"
              >
                <td className="px-3 py-2 font-mono tabular-nums whitespace-nowrap">
                  {formatDateTime(r.startAt)}
                </td>
                <td className="px-3 py-2 text-fg-muted">
                  {r.resourceName}
                  {r.note ? (
                    <span className="block text-[10px] text-fg-subtle mt-0.5">
                      {r.note}
                    </span>
                  ) : null}
                </td>
                <td className="px-3 py-2 font-mono tabular-nums text-right">
                  {r.slots}
                </td>
                <td className="px-3 py-2 font-mono tabular-nums text-right text-fg-muted">
                  {formatDollars(r.ratePerSlotCents)}
                </td>
                <td className="px-3 py-2 font-mono tabular-nums text-right text-fg">
                  {formatDollars(r.totalCents)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PaymentHistory({ payments }: { payments: PaymentHistoryRow[] }) {
  return (
    <section className="mb-8" aria-labelledby="history-heading">
      <h2
        id="history-heading"
        className="mb-3 text-xs uppercase tracking-[0.14em] text-fg-muted"
      >
        Payment history
      </h2>
      {payments.length === 0 ? (
        <div className="rounded-lg border border-line/60 bg-surface/40 px-4 py-8 text-center">
          <p className="text-sm text-fg-subtle">
            Nothing recorded yet. Once you pay, it&apos;ll show up here.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[480px]">
            <thead className="text-[10px] uppercase tracking-[0.14em] text-fg-subtle border-b border-line bg-surface">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Date</th>
                <th className="px-3 py-2 text-left font-medium">Method</th>
                <th className="px-3 py-2 text-right font-medium">Amount</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
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
                    {p.reference ? (
                      <span className="block text-[10px] text-fg-subtle mt-0.5">
                        {p.reference}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 font-mono tabular-nums text-right">
                    {formatDollars(p.amountCents)}
                  </td>
                  <td className="px-3 py-2">
                    <StatusPill status={p.status} />
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

function MarkPaidDialog({
  open,
  defaultMethod,
  defaultAmountCents,
  onClose,
}: {
  open: boolean;
  defaultMethod: "venmo" | "zelle" | "other" | null;
  defaultAmountCents: number;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [state, action, pending] = useActionState(
    submitOwnPaymentFormAction,
    INITIAL_STATE,
  );

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  const wasPending = useRef(false);
  useEffect(() => {
    if (wasPending.current && !pending && state.ok && state.submittedAt > 0 && open) {
      onClose();
    }
    wasPending.current = pending;
  }, [pending, state, open, onClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handler = () => {
      if (open) onClose();
    };
    dialog.addEventListener("close", handler);
    return () => dialog.removeEventListener("close", handler);
  }, [open, onClose]);

  const defaults = useMemo(() => {
    if (!state.ok && state.values) return state.values;
    return {
      amountDollars: (defaultAmountCents / 100).toFixed(2),
      method: defaultMethod ?? "venmo",
      paidAtDate: formatPfaDate(new Date()),
      reference: "",
      note: "",
    };
  }, [defaultAmountCents, defaultMethod, state]);

  // Re-key on a method change so the select inside the form re-mounts
  // with the new default (the "" → "venmo" → "zelle" transition).
  const formKey = state.ok
    ? `ok-${defaultMethod ?? "x"}-${defaultAmountCents}`
    : `err-${state.error.code}-${state.error.message}`;

  return (
    <dialog
      ref={dialogRef}
      className="m-auto w-full max-w-md rounded-lg border border-line bg-surface text-fg p-0 backdrop:bg-page/70 backdrop:backdrop-blur-sm"
    >
      <form action={action} key={formKey} className="space-y-4 p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.14em] text-fg-muted">
              Notify PFA
            </p>
            <h2 className="text-lg font-semibold tracking-tight mt-0.5">
              I just paid
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center justify-center h-8 w-8 -mr-1 -mt-1 rounded-md text-fg-muted hover:text-fg hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="text-xs text-fg-subtle leading-snug">
          We&apos;ll mark this as pending until PFA confirms it on their
          end — usually quick.
        </p>

        {!state.ok ? (
          <div
            role="alert"
            className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
          >
            {state.error.message}
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount" hint="In dollars (e.g. 150 or 150.00).">
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle text-sm">
                $
              </span>
              <input
                type="text"
                inputMode="decimal"
                name="amountDollars"
                required
                defaultValue={defaults.amountDollars}
                placeholder="0.00"
                className={`${inputStyles} pl-7`}
              />
            </div>
          </Field>
          <Field label="Date">
            <input
              type="date"
              name="paidAtDate"
              required
              defaultValue={defaults.paidAtDate}
              className={inputStyles}
            />
          </Field>
        </div>

        <Field label="Method">
          <select
            name="method"
            required
            defaultValue={defaults.method}
            className={selectStyles}
          >
            <option value="venmo">Venmo</option>
            <option value="zelle">Zelle</option>
            <option value="check">Check</option>
            <option value="cash">Cash</option>
            <option value="other">Other</option>
          </select>
        </Field>

        <Field label="Reference" optional hint="Venmo confirmation ID, check #, etc.">
          <input
            type="text"
            name="reference"
            defaultValue={defaults.reference}
            maxLength={200}
            placeholder="Optional"
            className={inputStyles}
          />
        </Field>

        <Field label="Note" optional>
          <input
            type="text"
            name="note"
            defaultValue={defaults.note}
            maxLength={500}
            placeholder="Optional"
            className={inputStyles}
          />
        </Field>

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-line bg-surface-2 text-fg-muted hover:text-fg hover:border-line-strong h-9 px-4 text-sm font-medium transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={pending}
            className="inline-flex items-center gap-1.5 rounded-md bg-gold text-gold-ink hover:bg-gold-hover h-9 px-4 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
          >
            <CheckCircle2 className="h-4 w-4" strokeWidth={2.5} />
            {pending ? "Submitting…" : "Submit"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function SubStat({
  label,
  value,
  muted,
}: {
  label: string;
  value: string;
  muted?: boolean;
}) {
  return (
    <div className="bg-surface px-3 py-2.5">
      <p className="text-[10px] uppercase tracking-[0.14em] text-fg-muted">
        {label}
      </p>
      <p
        className={`mt-1 font-mono tabular-nums tracking-tight text-base ${muted ? "text-fg-subtle" : "text-fg"}`}
      >
        {value}
      </p>
    </div>
  );
}

function Field({
  label,
  hint,
  optional,
  children,
}: {
  label: string;
  hint?: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="flex items-baseline justify-between mb-1.5">
        <span className="text-xs uppercase tracking-wider text-fg-muted">
          {label}
        </span>
        {optional ? (
          <span className="text-[10px] text-fg-subtle">optional</span>
        ) : null}
      </span>
      {children}
      {hint ? (
        <span className="block text-[11px] text-fg-subtle mt-1 leading-snug">
          {hint}
        </span>
      ) : null}
    </label>
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

function formatDateTime(d: Date): string {
  return d.toLocaleString("en-US", {
    timeZone: PFA_TIMEZONE,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const inputStyles =
  "w-full rounded-md bg-page border border-line text-fg placeholder:text-fg-subtle px-3 py-2 text-sm focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40";
const selectStyles = `${inputStyles} appearance-none pr-8`;
