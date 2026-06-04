"use client";

import { useMemo, useState, useTransition } from "react";
import { Check, ClipboardCopy, Pencil, Plus, Trash2 } from "lucide-react";
import { confirmPayment, deletePayment } from "../actions";
import { PaymentDialog, type PaymentInitialValues } from "./payment-dialog";
import { PFA_TIMEZONE } from "@/lib/timezone";
import { ConfirmDialog } from "@/app/_components/confirm-dialog";
import { ListSearch } from "@/app/_components/list-search";
import { nameMatchesQuery } from "@/app/_components/list-search.logic";

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
  zelleContact: string | null;
  owedCageCents: number;
  owedProgramCents: number;
  paidCents: number;
  balanceCents: number;
};

type BalanceTotals = {
  owedCage: number;
  owedProgram: number;
  paid: number;
  balance: number;
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
  totals: BalanceTotals;
  pendingPayments: PendingPaymentRow[];
  recentPayments: RecentPaymentRow[];
  coachOptions: CoachOption[];
}) {
  const [dialog, setDialog] = useState<DialogState>({ mode: "closed" });
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [confirmRow, setConfirmRow] = useState<RecentPaymentRow | null>(null);
  const [isDeleting, startTransition] = useTransition();
  const [balanceQuery, setBalanceQuery] = useState("");

  // Client-side coach-name filter over the already-loaded balance rows.
  // The totals row stays the full-roster total (see BalancesTable).
  const filteredBalanceRows = useMemo(
    () =>
      balanceRows.filter((r) =>
        nameMatchesQuery(balanceQuery, [r.coachName, r.coachEmail]),
      ),
    [balanceRows, balanceQuery],
  );

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
    setConfirmRow(row);
  };

  const handleConfirmDelete = () => {
    const row = confirmRow;
    if (!row) return;
    setPendingActionId(row.id);
    startTransition(async () => {
      try {
        await deletePayment(row.id);
        setConfirmRow(null);
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
          className="inline-flex items-center gap-1.5 rounded-lg bg-gold px-4 h-9 text-sm font-medium text-gold-ink shadow-[var(--shadow-sm)] hover:bg-gold-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
        >
          <Plus className="h-4 w-4" strokeWidth={2.5} />
          Record payment
        </button>
      </div>

      <BalancesTable
        rows={filteredBalanceRows}
        totalRowCount={balanceRows.length}
        totals={totals}
        onRecord={openCreate}
        query={balanceQuery}
        onQueryChange={setBalanceQuery}
      />

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

      <ConfirmDialog
        open={confirmRow !== null}
        onOpenChange={(next) => {
          if (!next) setConfirmRow(null);
        }}
        title="Delete this payment?"
        description={
          confirmRow
            ? `${formatDollars(confirmRow.amountCents)} ${confirmRow.method} from ${confirmRow.coachName} on ${formatDate(confirmRow.paidAt)}. This can't be undone.`
            : undefined
        }
        confirmLabel={isDeleting ? "Deleting…" : "Delete payment"}
        onConfirm={handleConfirmDelete}
        isPending={isDeleting}
      />
    </>
  );
}

function BalancesTable({
  rows,
  totalRowCount,
  totals,
  onRecord,
  query,
  onQueryChange,
}: {
  rows: BalanceRow[];
  totalRowCount: number;
  totals: BalanceTotals;
  onRecord: (coachId: string) => void;
  query: string;
  onQueryChange: (next: string) => void;
}) {
  // No coaches on the roster at all — nothing to search.
  if (totalRowCount === 0) {
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
        className="mb-3 text-[11.5px] font-semibold uppercase tracking-[0.14em] text-fg-muted"
      >
        Balances
      </h2>
      <div className="mb-3">
        <ListSearch
          value={query}
          onChange={onQueryChange}
          placeholder="Search coaches…"
          label="Search balances by coach"
          resultCount={rows.length}
          totalCount={totalRowCount}
        />
      </div>
      {rows.length === 0 ? (
        <div className="rounded-lg border border-line/60 bg-surface/40 p-10 text-center">
          <p className="text-sm text-fg-muted">
            No coaches match &ldquo;{query.trim()}&rdquo;.
          </p>
        </div>
      ) : (
      <div className="overflow-x-auto rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)]">
        <table className="w-full min-w-[680px]">
          <thead className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted border-b border-line bg-surface-2/50">
            <tr>
              <th scope="col" className="px-4 py-3 text-left font-semibold">
                Coach
              </th>
              <th scope="col" className="px-4 py-3 text-right font-semibold">
                Owed (cage)
              </th>
              <th scope="col" className="px-4 py-3 text-right font-semibold">
                Paid
              </th>
              <th scope="col" className="px-4 py-3 text-right font-semibold">
                Balance
              </th>
              <th
                scope="col"
                className="px-4 py-3 text-right font-semibold border-l border-line"
              >
                Program pay
                <span className="block text-[10px] font-normal normal-case tracking-normal text-fg-subtle">
                  PFA owes coach
                </span>
              </th>
              <th scope="col" className="px-4 py-3 text-right font-semibold sr-only">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.coachId}
                className="border-t border-line hover:bg-surface-2 transition-colors"
              >
                <td className="px-4 py-3 text-sm align-top">
                  <div className="flex flex-col gap-1">
                    <span>{row.coachName}</span>
                    {row.zelleContact ? (
                      <div className="flex flex-wrap items-center gap-1">
                        <HandleChip
                          label="Zelle"
                          value={row.zelleContact}
                        />
                      </div>
                    ) : null}
                  </div>
                </td>
                <td className="px-4 py-3 text-sm font-mono tnum tabular-nums text-right text-fg-muted whitespace-nowrap align-top">
                  {formatDollars(row.owedCageCents)}
                </td>
                <td className="px-4 py-3 text-sm font-mono tnum tabular-nums text-right text-fg-muted whitespace-nowrap align-top">
                  {formatDollars(row.paidCents)}
                </td>
                <td
                  className={`px-4 py-3 text-sm font-mono tnum tabular-nums text-right whitespace-nowrap align-top ${balanceColor(row.balanceCents)}`}
                >
                  {formatDollars(row.balanceCents)}
                </td>
                <td className="px-4 py-3 text-sm font-mono tnum tabular-nums text-right text-fg-muted whitespace-nowrap align-top border-l border-line">
                  {formatDollars(row.owedProgramCents)}
                </td>
                <td className="px-4 py-3 text-right whitespace-nowrap align-top">
                  <button
                    type="button"
                    onClick={() => onRecord(row.coachId)}
                    className="inline-flex items-center gap-1 rounded-lg border border-line-strong bg-surface text-fg-muted hover:text-fg hover:-translate-y-px shadow-[var(--shadow-sm)] hover:shadow-[var(--shadow-md)] h-8 px-3 text-xs font-medium transition"
                  >
                    <Plus className="h-3 w-3" strokeWidth={2.5} />
                    Record
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t border-line bg-surface-2/50">
            <tr className="text-sm font-medium">
              <td className="px-4 py-3 text-fg-muted align-top">
                Roster total
                {query.trim().length > 0 ? (
                  <span className="block text-[11px] font-normal text-fg-subtle">
                    Full roster — not the filtered set
                  </span>
                ) : null}
              </td>
              <td className="px-4 py-3 font-mono tnum tabular-nums text-right text-fg align-top">
                {formatDollars(totals.owedCage)}
              </td>
              <td className="px-4 py-3 font-mono tnum tabular-nums text-right text-fg align-top">
                {formatDollars(totals.paid)}
              </td>
              <td
                className={`px-4 py-3 font-mono tnum tabular-nums text-right align-top ${balanceColor(totals.balance)}`}
              >
                {formatDollars(totals.balance)}
              </td>
              <td className="px-4 py-3 font-mono tnum tabular-nums text-right text-fg-muted align-top border-l border-line">
                {formatDollars(totals.owedProgram)}
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      )}
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
        className="mb-3 text-[11.5px] font-semibold uppercase tracking-[0.14em] text-fg-muted"
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
        <div className="overflow-x-auto rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)]">
          <table className="w-full min-w-[640px]">
            <thead className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted border-b border-line bg-surface-2/50">
              <tr>
                <th className="px-4 py-3 text-left font-semibold">Date</th>
                <th className="px-4 py-3 text-left font-semibold">Coach</th>
                <th className="px-4 py-3 text-left font-semibold">Method</th>
                <th className="px-4 py-3 text-right font-semibold">Amount</th>
                <th className="px-4 py-3 text-left font-semibold">Reference</th>
                <th className="px-4 py-3 text-right font-semibold sr-only">
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
                    className={`border-t border-line hover:bg-surface-2 transition-colors ${isPending ? "opacity-50" : ""}`}
                  >
                    <td className="px-4 py-3 text-sm font-mono tnum tabular-nums whitespace-nowrap">
                      {formatDate(row.paidAt)}
                    </td>
                    <td className="px-4 py-3 text-sm">{row.coachName}</td>
                    <td className="px-4 py-3 text-sm text-fg-muted">
                      <MethodBadge method={row.method} />
                    </td>
                    <td className="px-4 py-3 text-sm font-mono tnum tabular-nums text-right whitespace-nowrap">
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
                        className="inline-flex items-center gap-1.5 rounded-lg bg-success/10 text-success hover:bg-success/20 ring-1 ring-inset ring-success/30 h-8 px-3 text-xs font-medium transition-colors disabled:opacity-50"
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
        className="mb-3 text-[11.5px] font-semibold uppercase tracking-[0.14em] text-fg-muted"
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
        <div className="overflow-x-auto rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)]">
          <table className="w-full min-w-[720px]">
            <thead className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted border-b border-line bg-surface-2/50">
              <tr>
                <th className="px-4 py-3 text-left font-semibold">Date</th>
                <th className="px-4 py-3 text-left font-semibold">Coach</th>
                <th className="px-4 py-3 text-left font-semibold">Method</th>
                <th className="px-4 py-3 text-right font-semibold">Amount</th>
                <th className="px-4 py-3 text-left font-semibold">Reference</th>
                <th className="px-4 py-3 text-left font-semibold">Status</th>
                <th className="px-4 py-3 text-right font-semibold sr-only">
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
                    className={`border-t border-line hover:bg-surface-2 transition-colors ${isPending ? "opacity-50" : ""}`}
                  >
                    <td className="px-4 py-3 text-sm font-mono tnum tabular-nums whitespace-nowrap">
                      {formatDate(row.paidAt)}
                    </td>
                    <td className="px-4 py-3 text-sm">{row.coachName}</td>
                    <td className="px-4 py-3 text-sm">
                      <MethodBadge method={row.method} />
                    </td>
                    <td className="px-4 py-3 text-sm font-mono tnum tabular-nums text-right whitespace-nowrap">
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
                          className="inline-flex items-center justify-center h-10 w-10 sm:h-8 sm:w-8 rounded-md text-fg-muted hover:text-fg hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors disabled:opacity-40"
                          aria-label="Edit payment"
                          title="Edit"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onDelete(row)}
                          disabled={isPending}
                          className="inline-flex items-center justify-center h-10 w-10 sm:h-8 sm:w-8 rounded-md text-fg-muted hover:text-danger hover:bg-danger/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 transition-colors disabled:opacity-40"
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
        <Check className="h-2.5 w-2.5 text-success" strokeWidth={2.5} />
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
      <span className="inline-flex items-center gap-1 rounded-full bg-success/10 text-success ring-1 ring-inset ring-success/30 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider">
        Confirmed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-warning/10 text-warning ring-1 ring-inset ring-warning/30 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider">
      Pending
    </span>
  );
}

function balanceColor(cents: number): string {
  if (cents > 0) return "text-fg";
  if (cents < 0) return "text-warning";
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
