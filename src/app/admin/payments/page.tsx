import Link from "next/link";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import { db } from "@/db";
import {
  coachPayments,
  sessionsBilling,
  users,
} from "@/db/schema";
import { requireRole } from "@/lib/authz";
import { totalFromSnapshot } from "@/lib/billing";
import { PaymentsClient, type CoachOption, type RecentPaymentRow } from "./_components/payments-client";

// /admin/payments — coach-to-PFA ledger. Three stacked sections:
//   1. Balances by coach: lifetime owed (rentals) minus lifetime
//      confirmed payments. Pending payments don't reduce the balance.
//   2. Pending inbox: coach-self-reported payments awaiting admin
//      confirmation. Phase P4 will populate this; for launch it
//      typically renders an empty state.
//   3. Recent payments: last 100 confirmed + pending entries with
//      inline edit / delete / confirm actions.
//
// Snapshot rule: per-coach owed sums sessionsBilling.ratePer30MinCents
// straight off each session row × its slot count. Renegotiating an
// override only affects future bookings — past balances never drift.
//
// All-time scope: imported historical data means lifetime-owed can be
// large at launch. Dad's workflow for backfilling historical
// settlement (a single "Pre-launch settlement" record per coach, or
// per-month breakdowns) is offline-driven; the app just shows the
// raw owed - paid math.

const RECENT_LIMIT = 100;

export default async function AdminPaymentsPage() {
  await requireRole("admin");

  // Run everything in parallel — these queries are independent.
  const [
    activeCoaches,
    sessionRows,
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
        coachId: coachPayments.coachId,
        amountCents: coachPayments.amountCents,
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

  // Per-coach owed = sum of session snapshot totals. Reading
  // sessionsBilling.ratePer30MinCents directly preserves the historical
  // rate at booking time — renegotiating an override never rewrites
  // past balances.
  const owedByCoach = new Map<string, number>();
  for (const s of sessionRows) {
    const total = totalFromSnapshot(s.startAt, s.endAt, s.ratePer30MinCents);
    owedByCoach.set(s.coachId, (owedByCoach.get(s.coachId) ?? 0) + total);
  }
  const paidByCoach = new Map<string, number>();
  for (const p of confirmedPaymentRows) {
    paidByCoach.set(
      p.coachId,
      (paidByCoach.get(p.coachId) ?? 0) + p.amountCents,
    );
  }

  // Roster rows + sort by balance descending (biggest debtors first).
  const balanceRows = activeCoaches
    .map((c) => {
      const owed = owedByCoach.get(c.id) ?? 0;
      const paid = paidByCoach.get(c.id) ?? 0;
      return {
        coachId: c.id,
        coachName: c.name ?? c.email,
        coachEmail: c.email,
        zelleContact: c.zelleContact,
        owedCents: owed,
        paidCents: paid,
        balanceCents: owed - paid,
      };
    })
    .sort((a, b) => b.balanceCents - a.balanceCents);

  // Grand totals across the active roster.
  const totals = balanceRows.reduce(
    (acc, r) => {
      acc.owed += r.owedCents;
      acc.paid += r.paidCents;
      acc.balance += r.balanceCents;
      return acc;
    },
    { owed: 0, paid: 0, balance: 0 },
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
    paidAt: p.paidAt,
    reference: p.reference,
    note: p.note,
    status: p.status,
    recordedAt: p.recordedAt,
  }));

  return (
    <>
      <Link
        href="/admin"
        className="inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg mb-6 transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back
      </Link>

      <div className="mb-8 space-y-1.5">
        <p className="text-xs uppercase tracking-[0.18em] text-fg-muted">
          Admin
        </p>
        <h1 className="text-3xl font-bold tracking-tight">Payments</h1>
        <p className="text-sm text-fg-muted">
          What each coach owes PFA, and the payment history. Only confirmed
          payments reduce the balance — pending entries wait in the inbox.
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
