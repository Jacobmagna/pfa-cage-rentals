import Link from "next/link";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import { db } from "@/db";
import {
  coachPayments,
  hourLogs,
  sessionsBilling,
  users,
} from "@/db/schema";
import { requireRole } from "@/lib/authz";
import { totalFromSnapshot, workPayForLog } from "@/lib/billing";
import { netCoachLedgers, type LedgerPayment } from "@/lib/payment-ledger";
import { PaymentsClient, type CoachOption, type RecentPaymentRow } from "./_components/payments-client";

// /admin/payments — TWO-direction coach ledger. Three stacked sections:
//   1. Balances by coach: two side-by-side ledgers per coach —
//      a) Cage rentals (coach OWES PFA): lifetime cage owed minus
//         confirmed coach_to_pfa payments.
//      b) Work hours (PFA OWES coach): lifetime work pay minus confirmed
//         pfa_to_coach payments.
//      Pending payments (either direction) don't reduce either balance.
//   2. Pending inbox: coach-self-reported payments awaiting admin
//      confirmation. Phase P4 will populate this; for launch it
//      typically renders an empty state.
//   3. Recent payments: last 100 confirmed + pending entries (each
//      tagged with its direction) with inline edit / delete / confirm.
//
// Money direction (QA2 #9): cage rentals are money the coach OWES PFA (a
// receivable, paid down by coach_to_pfa payments); work hours are money
// PFA PAYS the coach (a payout, paid down by pfa_to_coach payments). They
// flow OPPOSITE ways and are kept in SEPARATE ledgers — a payment in one
// direction NEVER nets against the other. The netting itself lives in the
// pure helper src/lib/payment-ledger.ts.
//
// Snapshot rule: each owed source is summed straight off its own snapshot —
// sessionsBilling.ratePer30MinCents (cage rentals) and
// workPayForLog(hour_logs row) (work hours; per-session rate if stamped,
// else the per-30-min snapshot). Renegotiating an override only affects
// future bookings / logs — past balances never drift.
//
// All-time scope: imported historical data means lifetime-owed can be
// large at launch. Dad's workflow for backfilling historical
// settlement (a single "Pre-launch settlement" record per coach, or
// per-month breakdowns) is offline-driven; the app just shows the
// raw cage-owed − paid math.

const RECENT_LIMIT = 100;

export default async function AdminPaymentsPage() {
  await requireRole("admin");

  // Run everything in parallel — these queries are independent.
  const [
    activeCoaches,
    sessionRows,
    hourLogRows,
    confirmedPaymentRows,
    pendingPaymentRows,
    recentRows,
  ] = await Promise.all([
    db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        zelleContact: users.zelleContact,
      })
      .from(users)
      .where(and(eq(users.role, "coach"), isNull(users.deletedAt)))
      .orderBy(asc(users.name), asc(users.email)),
    db
      .select({
        coachId: sessionsBilling.coachId,
        startAt: sessionsBilling.startAt,
        endAt: sessionsBilling.endAt,
        ratePer30MinCents: sessionsBilling.ratePer30MinCents,
      })
      .from(sessionsBilling),
    db
      .select({
        coachId: hourLogs.coachId,
        startAt: hourLogs.startAt,
        endAt: hourLogs.endAt,
        ratePer30MinCents: hourLogs.ratePer30MinCents,
        perSessionRateCents: hourLogs.perSessionRateCents,
      })
      // 1b security B: held logs are not part of the lifetime work-pay total.
      .from(hourLogs)
      .where(eq(hourLogs.status, "posted")),
    db
      .select({
        coachId: coachPayments.coachId,
        amountCents: coachPayments.amountCents,
        direction: coachPayments.direction,
      })
      .from(coachPayments)
      .where(
        and(
          isNull(coachPayments.deletedAt),
          eq(coachPayments.status, "confirmed"),
        ),
      ),
    db
      .select({
        id: coachPayments.id,
        coachId: coachPayments.coachId,
        coachName: users.name,
        coachEmail: users.email,
        amountCents: coachPayments.amountCents,
        method: coachPayments.method,
        direction: coachPayments.direction,
        paidAt: coachPayments.paidAt,
        reference: coachPayments.reference,
        note: coachPayments.note,
        recordedAt: coachPayments.recordedAt,
      })
      .from(coachPayments)
      .innerJoin(users, eq(coachPayments.coachId, users.id))
      .where(
        and(
          isNull(coachPayments.deletedAt),
          eq(coachPayments.status, "pending"),
        ),
      )
      .orderBy(desc(coachPayments.paidAt)),
    db
      .select({
        id: coachPayments.id,
        coachId: coachPayments.coachId,
        coachName: users.name,
        coachEmail: users.email,
        amountCents: coachPayments.amountCents,
        method: coachPayments.method,
        direction: coachPayments.direction,
        paidAt: coachPayments.paidAt,
        reference: coachPayments.reference,
        note: coachPayments.note,
        status: coachPayments.status,
        recordedAt: coachPayments.recordedAt,
      })
      .from(coachPayments)
      .innerJoin(users, eq(coachPayments.coachId, users.id))
      .where(isNull(coachPayments.deletedAt))
      .orderBy(desc(coachPayments.paidAt))
      .limit(RECENT_LIMIT),
  ]);

  // Cage owed (what the coach owes PFA) and work pay (what PFA owes the
  // coach) are summed from their own snapshots and kept in separate
  // ledgers. Reading the snapshot directly off each row preserves the
  // historical rate at booking / log time — renegotiating an override
  // never rewrites past balances.
  const owedCageByCoach = new Map<string, number>();
  for (const s of sessionRows) {
    const total = totalFromSnapshot(s.startAt, s.endAt, s.ratePer30MinCents);
    owedCageByCoach.set(
      s.coachId,
      (owedCageByCoach.get(s.coachId) ?? 0) + total,
    );
  }
  const owedWorkByCoach = new Map<string, number>();
  for (const h of hourLogRows) {
    // Work pay via the single read-side entry point: per-session flat rate
    // when stamped, else per-hour × exact duration off the per-30-min
    // snapshot. (workPayForLog tolerates null rate → $0.)
    const total = workPayForLog(h);
    owedWorkByCoach.set(
      h.coachId,
      (owedWorkByCoach.get(h.coachId) ?? 0) + total,
    );
  }
  // Confirmed payments grouped per coach, keeping direction so the netting
  // helper can route each into the correct ledger.
  const confirmedByCoach = new Map<string, LedgerPayment[]>();
  for (const p of confirmedPaymentRows) {
    const list = confirmedByCoach.get(p.coachId) ?? [];
    list.push({ amountCents: p.amountCents, direction: p.direction });
    confirmedByCoach.set(p.coachId, list);
  }

  // Roster rows. Each coach gets BOTH ledgers netted by direction; sorted
  // by cage balance descending (biggest cage debtors first — that's the
  // receivable Dad chases). Work pay shows alongside as PFA's payout.
  const balanceRows = activeCoaches
    .map((c) => {
      const ledgers = netCoachLedgers(
        owedCageByCoach.get(c.id) ?? 0,
        owedWorkByCoach.get(c.id) ?? 0,
        confirmedByCoach.get(c.id) ?? [],
      );
      return {
        coachId: c.id,
        coachName: c.name ?? c.email,
        coachEmail: c.email,
        zelleContact: c.zelleContact,
        owedCageCents: ledgers.owedCageCents,
        paidCageCents: ledgers.paidCageCents,
        cageBalanceCents: ledgers.cageBalanceCents,
        owedWorkCents: ledgers.owedWorkCents,
        paidWorkCents: ledgers.paidWorkCents,
        workBalanceCents: ledgers.workBalanceCents,
      };
    })
    .sort((a, b) => b.cageBalanceCents - a.cageBalanceCents);

  // Grand totals across the active roster.
  const totals = balanceRows.reduce(
    (acc, r) => {
      acc.owedCage += r.owedCageCents;
      acc.paidCage += r.paidCageCents;
      acc.cageBalance += r.cageBalanceCents;
      acc.owedWork += r.owedWorkCents;
      acc.paidWork += r.paidWorkCents;
      acc.workBalance += r.workBalanceCents;
      return acc;
    },
    {
      owedCage: 0,
      paidCage: 0,
      cageBalance: 0,
      owedWork: 0,
      paidWork: 0,
      workBalance: 0,
    },
  );

  const coachOptions: CoachOption[] = activeCoaches.map((c) => ({
    id: c.id,
    name: c.name,
    email: c.email,
  }));

  const pendingPayments = pendingPaymentRows.map((p) => ({
    id: p.id,
    coachId: p.coachId,
    coachName: p.coachName ?? p.coachEmail,
    amountCents: p.amountCents,
    method: p.method,
    direction: p.direction,
    paidAt: p.paidAt,
    reference: p.reference,
    note: p.note,
    recordedAt: p.recordedAt,
  }));

  const recentPayments: RecentPaymentRow[] = recentRows.map((p) => ({
    id: p.id,
    coachId: p.coachId,
    coachName: p.coachName ?? p.coachEmail,
    amountCents: p.amountCents,
    method: p.method,
    direction: p.direction,
    paidAt: p.paidAt,
    reference: p.reference,
    note: p.note,
    status: p.status,
    recordedAt: p.recordedAt,
  }));

  return (
    <>
      <Link
        href="/admin/records"
        className="inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg mb-6 transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to Billing &amp; Records
      </Link>

      <div className="mb-8 space-y-1.5">
        <p className="text-[11.5px] font-semibold uppercase tracking-[0.14em] text-fg-muted">
          Admin
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Payments</h1>
        <p className="text-sm text-fg-muted">
          Two separate ledgers per coach.{" "}
          <span className="font-medium text-fg">Owes PFA (rentals)</span> = cage
          owed − confirmed <em>coach&nbsp;paid&nbsp;PFA</em> payments;{" "}
          <span className="font-medium text-fg">PFA owes (work)</span> = work pay
          − confirmed <em>PFA&nbsp;paid&nbsp;coach</em> payments. The two never
          net against each other. Only confirmed payments move a balance —
          pending entries wait in the inbox.
        </p>
        <p className="text-xs italic text-fg-subtle md:hidden">
          This page is designed for desktop. Rotate your device or use a
          laptop for the full experience.
        </p>
      </div>

      <PaymentsClient
        balanceRows={balanceRows}
        totals={totals}
        pendingPayments={pendingPayments}
        recentPayments={recentPayments}
        coachOptions={coachOptions}
      />
    </>
  );
}
