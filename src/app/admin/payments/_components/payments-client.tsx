"use client";

import { useState, useTransition } from "react";
import { Check, ClipboardCopy, Pencil, Plus, Trash2 } from "lucide-react";
import { confirmPayment, deletePayment } from "../actions";
import { PaymentDialog, type PaymentInitialValues } from "./payment-dialog";
import { PFA_TIMEZONE } from "@/lib/timezone";

// Top-level client island for /admin/payments. Owns:
//   - record/edit dialog open state
//   - pending row confirm/reject transition
//   - recent row delete transition
//
// Three sections render top-to-bottom: balances, pending inbox,
// recent history. Each is its own subcomponent so the file stays
// readable.

export type CoachOption = {
  id: string;
  name: string | null;
  email: string;
};

export type BalanceRow = {
  coachId: string;
  coachName: string;
  coachEmail: string;
  venmoHandle: string | null;
  zelleContact: string | null;
  owedCents: number;
  paidCents: number;
  balanceCents: number;
};

export type PendingPaymentRow = {
  id: string;
  coachId: string;
  coachName: string;
  amountCents: number;
  method: "venmo" | "zelle" | "check" | "cash" | "other";
  paidAt: Date;
  reference: string | null;
  note: string | null;
  recordedAt: Date;
};

export type RecentPaymentRow = {
  id: string;
  coachId: string;
  coachName: string;
  amountCents: number;
  method: "venmo" | "zelle" | "check" | "cash" | "other";
  paidAt: Date;
  reference: string | null;
  note: string | null;
  status: "pending" | "confirmed";
  recordedAt: Date;
};

type DialogState =
  | { mode: "closed" }
  | { mode: "create"; coachId?: string }
  | { mode: "edit"; row: RecentPaymentRow };

export function PaymentsClient({
  balanceRows,
  totals,
  pendingPayments,
  recentPayments,
  coachOptions,
}: {
  balanceRows: BalanceRow[];
  totals: { owed: number; paid: number; balance: number };
  pendingPayments: PendingPaymentRow[];
  recentPayments: RecentPaymentRow[];
  coachOptions: CoachOption[];
}) {
  const [dialog, setDialog] = useState<DialogState>({ mode: "closed" });
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const openCreate = (coachId?: string) =>
    setDialog({ mode: "create", coachId });
  const openEdit = (row: RecentPaymentRow) =>
    setDialog({ mode: "edit", row });
  const close = () => setDialog({ mode: "closed" });

  const onConfirm = (row: PendingPaymentRow) => {
    setPendingActionId(row.id);
    startTransition(async () => {
      try {
        await confirmPayment(row.id);
      } finally {
        setPendingActionId(null);
      }
    });
  };

  const onDelete = (row: RecentPaymentRow) => {
    if (
      !confirm(
        `Delete ${formatDollars(row.amountCents)} ${row.method} payment from ${row.coachName} (${formatDate(row.paidAt)})?\nThis can't be undone.`,
      )
    ) {
      return;
    }
    setPendingActionId(row.id);
    startTransition(async () => {
      try {
        await deletePayment(row.id);
      } finally {
        setPendingActionId(null);
      }
    });
  };

  const initialForEdit: PaymentInitialValues | undefined =
    dialog.mode === "edit"
      ? {
          id: dialog.row.id,
          coachId: dialog.row.coachId,
          amountCents: dialog.row.amountCents,
          method: dialog.row.method,
          paidAt: dialog.row.paidAt,
          reference: dialog.row.reference,
          note: dialog.row.note,
        }
      : undefined;

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-xs uppercase tracking-[0.14em] text-fg-subtle">
          {balanceRows.length}{" "}
          {balanceRows.length === 1 ? "coach" : "coaches"} on the roster
        </p>
        <button
          type="button"
          onClick={() => openCreate()}
          className="inline-flex items-center gap-1.5 rounded-md bg-gold px-4 h-9 text-sm font-medium text-gold-ink hover:bg-gold-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
        >
          <Plus className="h-4 w-4" strokeWidth={2.5} />
          Record payment
        </button>
      </div>

      <BalancesTable rows={balanceRows} totals={totals} onRecord={openCreate} />

      <PendingInbox
        rows={pendingPayments}
        onConfirm={onConfirm}
        pendingActionId={pendingActionId}
      />

      <RecentTable
        rows={recentPayments}
        onEdit={openEdit}
        onDelete={onDelete}
        pendingActionId={pendingActionId}
      />

      <PaymentDialog
        open={dialog.mode !== "closed"}
        mode={dialog.mode === "edit" ? "edit" : "create"}
        onClose={close}
        coachOptions={coachOptions}
        initial={initialForEdit}
        prefillCoachId={
          dialog.mode === "create" ? dialog.coachId ?? null : null
        }
      />
    </>
  );
}

function BalancesTable({
  rows,
  totals,
  onRecord,
}: {
  rows: BalanceRow[];
  totals: { owed: number; paid: number; balance: number };
  onRecord: (coachId: string) => void;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-line/60 bg-surface/40 p-10 text-center mb-10">
        <p className="text-sm text-fg-muted">
          No active coaches yet — add some via /admin/coaches.
        </p>
      </div>
    );
  }
  return (
    <section className="mb-10" aria-labelledby="balances-heading">
      <h2
        id="balances-heading"
        className="mb-3 text-xs uppercase tracking-[0.14em] text-fg-muted"
      >
        Balances
      </h2>
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-[560px]">
          <thead className="text-[11px] uppercase tracking-[0.14em] text-fg-subtle border-b border-line bg-surface">
            <tr>
              <th scope="col" className="px-4 py-3 text-left font-medium">
                Coach
              </th>
              <th scope="col" className="px-4 py-3 text-right font-medium">
                Owed
              </th>
              <th scope="col" className="px-4 py-3 text-right font-medium">
                Paid
              </th>
              <th scope="col" className="px-4 py-3 text-right font-medium">
                Balance
              </th>
              <th scope="col" className="px-4 py-3 text-right font-medium sr-only">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.coachId}
                className="border-b border-line/50 last:border-b-0 hover:bg-surface/60 transition-colors"
              >
                <td className="px-4 py-3 text-sm">
                  <div className="flex flex-col gap-1">
                    <span>{row.coachName}</span>
                    {row.venmoHandle || row.zelleContact ? (
                      <div className="flex flex-wrap items-center gap-1">
                        {row.venmoHandle ? (
                          <HandleChip
                            label="Venmo"
                            value={`@${row.venmoHandle}`}
                          />
                        ) : null}
                        {row.zelleContact ? (
                          <HandleChip
                            label="Zelle"
                            value={row.zelleContact}
                          />
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </td>
                <td className="px-4 py-3 text-sm font-mono tabular-nums text-right text-fg-muted whitespace-nowrap">
                  {formatDollars(row.owedCents)}
                </td>
                <td className="px-4 py-3 text-sm font-mono tabular-nums text-right text-fg-muted whitespace-nowrap">
                  {formatDollars(row.paidCents)}
                </td>
                <td
                  className={`px-4 py-3 text-sm font-mono tabular-nums text-right whitespace-nowrap ${balanceColor(row.balanceCents)}`}
                >
                  {formatDollars(row.balanceCents)}
                </td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  <button
                    type="button"
                    onClick={() => onRecord(row.coachId)}
                    className="inline-flex items-center gap-1 rounded-md border border-line bg-surface-2 text-fg-muted hover:text-fg hover:border-line-strong h-8 px-3 text-xs font-medium transition-colors"
                  >
                    <Plus className="h-3 w-3" strokeWidth={2.5} />
                    Record
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t border-line bg-surface">
            <tr className="text-sm font-medium">
              <td className="px-4 py-3 text-fg-muted">Roster total</td>
              <td className="px-4 py-3 font-mono tabular-nums text-right text-fg">
                {formatDollars(totals.owed)}
              </td>
              <td className="px-4 py-3 font-mono tabular-nums text-right text-fg">
                {formatDollars(totals.paid)}
              </td>
              <td
                className={`px-4 py-3 font-mono tabular-nums text-right ${balanceColor(totals.balance)}`}
              >
                {formatDollars(totals.balance)}
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

function PendingInbox({
  rows,
  onConfirm,
  pendingActionId,
}: {
  rows: PendingPaymentRow[];
  onConfirm: (row: PendingPaymentRow) => void;
  pendingActionId: string | null;
}) {
  return (
    <section className="mb-10" aria-labelledby="pending-heading">
      <h2
        id="pending-heading"
        className="mb-3 text-xs uppercase tracking-[0.14em] text-fg-muted"
      >
        Awaiting confirmation
      </h2>
      {rows.length === 0 ? (
        <div className="rounded-lg border border-line/60 bg-surface/40 px-4 py-6 text-center">
          <p className="text-sm text-fg-subtle">
            Nothing to review. Coach-reported payments will show up here for
            you to confirm.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[640px]">
            <thead className="text-[11px] uppercase tracking-[0.14em] text-fg-subtle border-b border-line bg-surface">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Date</th>
                <th className="px-4 py-3 text-left font-medium">Coach</th>
                <th className="px-4 py-3 text-left font-medium">Method</th>
                <th className="px-4 py-3 text-right font-medium">Amount</th>
                <th className="px-4 py-3 text-left font-medium">Reference</th>
                <th className="px-4 py-3 text-right font-medium sr-only">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const isPending = pendingActionId === row.id;
                return (
                  <tr
                    key={row.id}
                    className={`border-b border-line/50 last:border-b-0 ${isPending ? "opacity-50" : ""}`}
                  >
                    <td className="px-4 py-3 text-sm font-mono tabular-nums whitespace-nowrap">
                      {formatDate(row.paidAt)}
                    </td>
                    <td className="px-4 py-3 text-sm">{row.coachName}</td>
                    <td className="px-4 py-3 text-sm text-fg-muted">
                      <MethodBadge method={row.method} />
                    </td>
                    <td className="px-4 py-3 text-sm font-mono tabular-nums text-right whitespace-nowrap">
                      {formatDollars(row.amountCents)}
                    </td>
                    <td className="px-4 py-3 text-xs text-fg-subtle">
                      {row.reference ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => onConfirm(row)}
                        disabled={isPending}
                        className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 ring-1 ring-inset ring-emerald-500/30 h-8 px-3 text-xs font-medium transition-colors disabled:opacity-50"
                      >
                        <Check className="h-3.5 w-3.5" strokeWidth={2.5} />
                        Confirm
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RecentTable({
  rows,
  onEdit,
  onDelete,
  pendingActionId,
}: {
  rows: RecentPaymentRow[];
  onEdit: (row: RecentPaymentRow) => void;
  onDelete: (row: RecentPaymentRow) => void;
  pendingActionId: string | null;
}) {
  return (
    <section aria-labelledby="recent-heading">
      <h2
        id="recent-heading"
        className="mb-3 text-xs uppercase tracking-[0.14em] text-fg-muted"
      >
        Recent payments
      </h2>
      {rows.length === 0 ? (
        <div className="rounded-lg border border-line/60 bg-surface/40 px-4 py-10 text-center">
          <p className="text-sm text-fg-muted">
            No payments recorded yet. Hit{" "}
            <span className="text-fg">Record payment</span> above to log one.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[720px]">
            <thead className="text-[11px] uppercase tracking-[0.14em] text-fg-subtle border-b border-line bg-surface">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Date</th>
                <th className="px-4 py-3 text-left font-medium">Coach</th>
                <th className="px-4 py-3 text-left font-medium">Method</th>
                <th className="px-4 py-3 text-right font-medium">Amount</th>
                <th className="px-4 py-3 text-left font-medium">Reference</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium sr-only">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const isPending = pendingActionId === row.id;
                return (
                  <tr
                    key={row.id}
                    className={`border-b border-line/50 last:border-b-0 hover:bg-surface/60 transition-colors ${isPending ? "opacity-50" : ""}`}
                  >
                    <td className="px-4 py-3 text-sm font-mono tabular-nums whitespace-nowrap">
                      {formatDate(row.paidAt)}
                    </td>
                    <td className="px-4 py-3 text-sm">{row.coachName}</td>
                    <td className="px-4 py-3 text-sm">
                      <MethodBadge method={row.method} />
                    </td>
                    <td className="px-4 py-3 text-sm font-mono tabular-nums text-right whitespace-nowrap">
                      {formatDollars(row.amountCents)}
                    </td>
                    <td className="px-4 py-3 text-xs text-fg-subtle truncate max-w-[180px]">
                      {row.reference ?? "—"}
                      {row.note ? (
                        <span className="block text-[10px] text-fg-subtle/80 mt-0.5">
                          {row.note}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      <StatusBadge status={row.status} />
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => onEdit(row)}
                          disabled={isPending}
                          className="inline-flex items-center justify-center h-8 w-8 rounded-md text-fg-muted hover:text-fg hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors disabled:opacity-40"
                          aria-label="Edit payment"
                          title="Edit"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onDelete(row)}
                          disabled={isPending}
                          className="inline-flex items-center justify-center h-8 w-8 rounded-md text-fg-muted hover:text-danger hover:bg-danger/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 transition-colors disabled:opacity-40"
                          aria-label="Delete payment"
                          title="Delete"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// Small chip that copies the underlying value to the clipboard on
// click. Used to surface a coach's Venmo/Zelle handle inline on the
// balances row — when Dad sees a Venmo notification with an unknown
// handle, he can scan + click to confirm whose row to credit.
function HandleChip({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const onClick = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Silent — older browsers / insecure context.
    }
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-full bg-surface-2 hover:bg-surface ring-1 ring-inset ring-line text-fg-muted hover:text-fg px-1.5 py-px text-[10px] font-medium transition-colors"
      title={`Copy ${value}`}
    >
      <span className="uppercase tracking-wider text-fg-subtle">{label}</span>
      <span className="font-mono">{value}</span>
      {copied ? (
        <Check className="h-2.5 w-2.5 text-emerald-300" strokeWidth={2.5} />
      ) : (
        <ClipboardCopy className="h-2.5 w-2.5" strokeWidth={2.5} />
      )}
    </button>
  );
}

function MethodBadge({ method }: { method: RecentPaymentRow["method"] }) {
  const label = method.charAt(0).toUpperCase() + method.slice(1);
  return (
    <span className="inline-block rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-fg-muted">
      {label}
    </span>
  );
}

function StatusBadge({ status }: { status: "pending" | "confirmed" }) {
  if (status === "confirmed") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 text-emerald-300 ring-1 ring-inset ring-emerald-500/30 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider">
        Confirmed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 text-amber-300 ring-1 ring-inset ring-amber-500/30 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider">
      Pending
    </span>
  );
}

function balanceColor(cents: number): string {
  if (cents > 0) return "text-fg";
  if (cents < 0) return "text-amber-300";
  return "text-fg-subtle";
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
