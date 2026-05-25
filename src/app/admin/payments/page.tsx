import Link from "next/link";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import { db } from "@/db";
import {
  coachPayments,
  coachRateOverrides,
  resources,
  sessionsBilling,
  users,
} from "@/db/schema";
import { requireRole } from "@/lib/authz";
import {
  computeBalances,
  type BalancePaymentInput,
  type BalanceSessionInput,
} from "@/lib/payments/balances";
import type { RateOverride, ResourceType } from "@/lib/billing";
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
    overrideRows,
    confirmedPaymentRows,
    pendingPaymentRows,
    recentRows,
  ] = await Promise.all([
    db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        venmoHandle: users.venmoHandle,
        zelleContact: users.zelleContact,
      })
      .from(users)
      .where(and(eq(users.role, "coach"), isNull(users.deletedAt)))
      .orderBy(asc(users.name), asc(users.email)),
    db
      .select({
        coachId: sessionsBilling.coachId,
        resourceType: resources.type,
        startAt: sessionsBilling.startAt,
        endAt: sessionsBilling.endAt,
      })
      .from(sessionsBilling)
      .innerJoin(resources, eq(sessionsBilling.resourceId, resources.id)),
    db.select().from(coachRateOverrides),
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

  // Build the balance map.
  const coachIds = activeCoaches.map((c) => c.id);
  const overrides: RateOverride[] = overrideRows.map((o) => ({
    coachId: o.coachId,
    resourceType: o.resourceType,
    ratePer30MinCents: o.ratePer30MinCents,
  }));
  const sessions: BalanceSessionInput[] = sessionRows.map((s) => ({
    coachId: s.coachId,
    resourceType: s.resourceType as ResourceType,
    startAt: s.startAt,
    endAt: s.endAt,
  }));
  const payments: BalancePaymentInput[] = confirmedPaymentRows.map((p) => ({
    coachId: p.coachId,
    amountCents: p.amountCents,
  }));
  const balances = computeBalances(coachIds, sessions, overrides, payments);

  // Roster rows + sort by balance descending (biggest debtors first).
  const balanceRows = activeCoaches
    .map((c) => {
      const b = balances.get(c.id);
      return {
        coachId: c.id,
        coachName: c.name ?? c.email,
        coachEmail: c.email,
        venmoHandle: c.venmoHandle,
        zelleContact: c.zelleContact,
        owedCents: b?.owedCents ?? 0,
        paidCents: b?.paidCents ?? 0,
        balanceCents: b?.balanceCents ?? 0,
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
