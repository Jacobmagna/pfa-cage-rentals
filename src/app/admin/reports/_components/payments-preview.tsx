"use client";

// The PAYMENTS tab of /admin/reports (reports-tabs SPEC §3, tab 3).
//
// An append-only TIMELINE OF ACTIONS, newest first — not a balance sheet.
// Two rules from the spec are load-bearing in this file:
//
//  1. HISTORY IS NOT EDITABLE. A row records something that happened.
//     The edit affordance therefore appears ONLY on the newest row for a
//     given payment (`isLatestInRange`) — the row that represents current
//     state — so the button never implies "change what happened then".
//     An edit APPENDS a new event; the list re-renders with both.
//
//  2. THE EDIT GOES THROUGH THE EXISTING `updatePayment`. This reuses the
//     Payments page's own `PaymentDialog` verbatim rather than growing a
//     second edit form, which is what guarantees this surface writes the
//     same audit rows the Payments page does and cannot drift from it.
//
// A soft-deleted payment gets NO edit affordance: `getActivePaymentOrThrow`
// refuses it server-side, and offering a button the server will reject is
// its own small betrayal.

import { useState } from "react";
import { Pencil } from "lucide-react";
import { PaymentDialog } from "@/app/admin/payments/_components/payment-dialog";
import type { CoachOption } from "@/app/admin/payments/_components/payments-client";
import type {
  PaymentCurrentValues,
  PaymentEventKind,
  PaymentTimelineEvent,
  PaymentTimelineTotals,
} from "@/lib/reports/payments-timeline";
import type { PaymentMethod } from "@/lib/schemas/payment";
import { formatPfaDateMedium, formatPfaTime12h } from "@/lib/timezone";

const KIND_LABEL: Record<PaymentEventKind, string> = {
  recorded: "Recorded",
  edited: "Edited",
  confirmed: "Confirmed",
  deleted: "Deleted",
};

const KIND_CLASS: Record<PaymentEventKind, string> = {
  recorded: "bg-gold/15 text-fg border-gold/30",
  edited: "bg-surface-2 text-fg-muted border-line-strong",
  confirmed: "bg-surface-2 text-fg-muted border-line-strong",
  deleted: "bg-surface-2 text-fg-subtle border-line-strong line-through",
};

export function PaymentsPreview({
  events,
  totals,
  truncated,
  coachOptions,
}: {
  events: PaymentTimelineEvent[];
  totals: PaymentTimelineTotals;
  truncated: boolean;
  coachOptions: CoachOption[];
}) {
  const [editing, setEditing] = useState<PaymentCurrentValues | null>(null);

  return (
    <div className="space-y-6">
      <RangeCaveat totals={totals} />

      <TotalsRow totals={totals} />

      {truncated ? (
        <p className="rounded-lg border border-line-strong bg-surface-2/60 px-4 py-3 text-xs text-fg">
          Showing the most recent entries only — this range has more than
          fit on one page. Narrow the dates or pick a coach to see the rest.
        </p>
      ) : null}

      {events.length === 0 ? (
        <div className="rounded-lg border border-line/60 bg-surface/40 p-10 text-center">
          <p className="text-sm font-medium text-fg">
            No payment activity in this range
          </p>
          <p className="mt-1.5 text-sm text-fg-muted max-w-md mx-auto">
            Nothing was recorded, edited, confirmed or deleted between these
            dates. Try widening the range or clearing the coach filter.
          </p>
        </div>
      ) : (
        <ol className="space-y-2">
          {events.map((event) => (
            <li
              key={event.id}
              className="rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)] px-4 py-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${KIND_CLASS[event.kind]}`}
                    >
                      {KIND_LABEL[event.kind]}
                    </span>
                    <span className="font-mono tnum tabular-nums text-xs text-fg-subtle">
                      {formatPfaDateMedium(event.ts)} ·{" "}
                      {formatPfaTime12h(event.ts)}
                    </span>
                  </div>

                  <p className="text-sm text-fg">
                    <span className="font-medium">{event.actorLabel}</span>{" "}
                    {verbFor(event.kind)}{" "}
                    <span className="font-medium">{event.coachLabel}</span>
                    {event.amountCents !== null ? (
                      <>
                        {" "}
                        <span className="font-mono tnum tabular-nums font-semibold">
                          {formatCents(event.amountCents)}
                        </span>
                      </>
                    ) : null}
                    {event.direction !== null ? (
                      <span className="text-fg-muted">
                        {" "}
                        · {directionLabel(event.direction)}
                      </span>
                    ) : null}
                  </p>

                  {event.changes.length > 0 ? (
                    <ul className="text-xs text-fg-muted space-y-0.5">
                      {event.changes.map((c) => (
                        <li key={c.label}>
                          <span className="text-fg-subtle">{c.label}:</span>{" "}
                          <span className="line-through">{c.from ?? "—"}</span>
                          {" → "}
                          <span className="text-fg">{c.to ?? "—"}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  {event.paymentDeleted && event.kind !== "deleted" ? (
                    <p className="text-[11px] text-fg-subtle">
                      This payment has since been deleted.
                    </p>
                  ) : null}
                </div>

                {/* Only on the row that represents CURRENT state, and only
                    while the payment is still live. */}
                {event.isLatestInRange &&
                !event.paymentDeleted &&
                event.current !== null ? (
                  <button
                    type="button"
                    onClick={() => setEditing(event.current)}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 h-8 text-xs font-medium text-fg hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    Edit payment
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}

      <PaymentDialog
        open={editing !== null}
        mode="edit"
        onClose={() => setEditing(null)}
        coachOptions={coachOptions}
        initial={
          editing
            ? { ...editing, method: editing.method as PaymentMethod }
            : undefined
        }
      />
    </div>
  );
}

// SPEC §11 decision 4. These totals are RANGED and will legitimately not
// match the Payments page's all-time balances. An unlabelled difference
// between two money screens reads as a bug in the money, so the label is
// not decoration — it is the thing that stops a support conversation.
function RangeCaveat({ totals }: { totals: PaymentTimelineTotals }) {
  return (
    <p className="rounded-lg border border-line/60 bg-surface-2/40 px-4 py-3 text-xs text-fg-muted leading-relaxed">
      <span className="font-semibold text-fg">
        Everything that happened to payments in this date range.
      </span>{" "}
      The totals below cover payments <em>recorded</em> in the range — they
      are not balances, and they will not match the all-time figures on the
      Payments page.
      {totals.recordedSinceDeletedCount > 0 ? (
        <>
          {" "}
          <span className="text-fg">
            {totals.recordedSinceDeletedCount} of them{" "}
            {totals.recordedSinceDeletedCount === 1 ? "has" : "have"} since
            been deleted and {totals.recordedSinceDeletedCount === 1 ? "is" : "are"}{" "}
            still counted here.
          </span>
        </>
      ) : null}
    </p>
  );
}

// The two directions sit side by side and are NEVER netted (SPEC §7).
function TotalsRow({ totals }: { totals: PaymentTimelineTotals }) {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <TotalCard
        label="Recorded — coach paid PFA"
        value={formatCents(totals.recordedCoachToPfaCents)}
      />
      <TotalCard
        label="Recorded — PFA paid coach"
        value={formatCents(totals.recordedPfaToCoachCents)}
      />
      <TotalCard
        label="Payments recorded"
        value={String(totals.recordedCount)}
      />
    </div>
  );
}

function TotalCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)] px-4 py-3">
      <p className="text-[10px] uppercase tracking-[0.18em] text-fg-subtle">
        {label}
      </p>
      <p className="mt-0.5 text-xl font-semibold font-mono tnum tabular-nums text-fg">
        {value}
      </p>
    </div>
  );
}

function verbFor(kind: PaymentEventKind): string {
  switch (kind) {
    case "recorded":
      return "recorded a payment for";
    case "edited":
      return "edited the payment for";
    case "confirmed":
      return "confirmed the payment for";
    case "deleted":
      return "deleted the payment for";
  }
}

function directionLabel(d: "coach_to_pfa" | "pfa_to_coach"): string {
  return d === "coach_to_pfa" ? "Coach paid PFA" : "PFA paid coach";
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
