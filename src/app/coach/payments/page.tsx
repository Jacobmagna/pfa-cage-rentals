import Link from "next/link";
import { and, desc, eq, isNull } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import { db } from "@/db";
import {
  coachPayments,
  coachRateOverrides,
  resources,
  sessionsBilling,
} from "@/db/schema";
import { requireSession } from "@/lib/authz";
import {
  chargeForSession,
  type RateOverride,
  type ResourceType,
} from "@/lib/billing";
import { getOrgSettings } from "@/lib/server/handles-actions";
import { CoachPaymentsClient } from "./_components/coach-payments-client";

// /coach/payments — coach-facing payments ledger. This is the V2
// invoice surface promised in the project_coach_rate_visibility
// memory. Until this page shipped, coaches saw zero dollar amounts;
// after this page, they see their own rental charges + their own
// payment history. Still NOT visible to coaches: other coaches'
// rates, PFA's grand totals, the admin pending inbox.
//
// Pay flow:
//   1. Coach sees their balance and can copy PFA's Venmo / Zelle.
//   2. They send the actual payment outside the app (Venmo deep link
//      pre-fills the recipient + amount; Zelle has to happen inside
//      their bank app).
//   3. They tap "I just paid" → submits a `pending` coach_payments
//      row. Dad confirms it on /admin/payments before it reduces the
//      balance — protects against typos and bad-faith claims.

export default async function CoachPaymentsPage() {
  const session = await requireSession();
  const coachId = session.user.id;

  const [sessionRows, overrideRows, paymentRows, orgSettings] =
    await Promise.all([
      db
        .select({
          id: sessionsBilling.id,
          resourceType: resources.type,
          resourceName: resources.name,
          startAt: sessionsBilling.startAt,
          endAt: sessionsBilling.endAt,
          note: sessionsBilling.note,
        })
        .from(sessionsBilling)
        .innerJoin(resources, eq(sessionsBilling.resourceId, resources.id))
        .where(eq(sessionsBilling.coachId, coachId))
        .orderBy(desc(sessionsBilling.startAt)),
      // Only this coach's overrides. Other coaches' rates stay hidden.
      db
        .select()
        .from(coachRateOverrides)
        .where(eq(coachRateOverrides.coachId, coachId)),
      db
        .select({
          id: coachPayments.id,
          amountCents: coachPayments.amountCents,
          method: coachPayments.method,
          paidAt: coachPayments.paidAt,
          reference: coachPayments.reference,
          note: coachPayments.note,
          status: coachPayments.status,
          recordedAt: coachPayments.recordedAt,
        })
        .from(coachPayments)
        .where(
          and(
            eq(coachPayments.coachId, coachId),
            isNull(coachPayments.deletedAt),
          ),
        )
        .orderBy(desc(coachPayments.paidAt)),
      getOrgSettings(),
    ]);

  const overrides: RateOverride[] = overrideRows.map((o) => ({
    coachId: o.coachId,
    resourceType: o.resourceType,
    ratePer30MinCents: o.ratePer30MinCents,
  }));

  // Per-session charge for the rentals list (so the coach can see how
  // each line item adds up). chargeForSession is pure; running it per
  // row at the page level is fine at coach-roster scale.
  const rentals = sessionRows.map((s) => {
    const charge = chargeForSession(
      {
        coachId,
        resourceType: s.resourceType as ResourceType,
        startAt: s.startAt,
        endAt: s.endAt,
      },
      overrides,
    );
    return {
      id: s.id,
      resourceName: s.resourceName,
      resourceType: s.resourceType,
      startAt: s.startAt,
      endAt: s.endAt,
      note: s.note,
      slots: charge.slots,
      ratePerSlotCents: charge.ratePer30MinCents,
      totalCents: charge.totalCents,
    };
  });

  const owedCents = rentals.reduce((sum, r) => sum + r.totalCents, 0);
  const confirmedPaidCents = paymentRows
    .filter((p) => p.status === "confirmed")
    .reduce((sum, p) => sum + p.amountCents, 0);
  const pendingCents = paymentRows
    .filter((p) => p.status === "pending")
    .reduce((sum, p) => sum + p.amountCents, 0);
  const balanceCents = owedCents - confirmedPaidCents;

  // Sort confirmed-then-pending so the "paid" history is the visual
  // anchor and pending entries float to the top with their own badge.
  const sortedPayments = [...paymentRows].sort((a, b) => {
    if (a.status !== b.status) return a.status === "pending" ? -1 : 1;
    return b.paidAt.getTime() - a.paidAt.getTime();
  });

  return (
    <div className="max-w-3xl">
      <Link
        href="/coach"
        className="inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg mb-6 transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back
      </Link>

      <div className="mb-8 space-y-1.5">
        <p className="text-xs uppercase tracking-[0.18em] text-fg-muted">
          Payments
        </p>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
          What you owe PFA
        </h1>
        <p className="text-sm text-fg-muted">
          Tap a pay button below, send the money through Venmo or Zelle,
          then let us know — we&apos;ll confirm and update your balance.
        </p>
      </div>

      <CoachPaymentsClient
        owedCents={owedCents}
        paidCents={confirmedPaidCents}
        pendingCents={pendingCents}
        balanceCents={balanceCents}
        rentals={rentals}
        payments={sortedPayments}
        pfaDisplayName={orgSettings.pfaDisplayName}
        pfaVenmoHandle={orgSettings.pfaVenmoHandle}
        pfaZelleContact={orgSettings.pfaZelleContact}
      />
    </div>
  );
}
