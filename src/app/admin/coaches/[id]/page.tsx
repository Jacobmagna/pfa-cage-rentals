import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq, isNull } from "drizzle-orm";
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
  chargeForSession,
  DEFAULT_RATES_PER_SLOT_CENTS,
  type RateOverride,
  type ResourceType,
} from "@/lib/billing";
import { formatPfaDateMedium } from "@/lib/timezone";
import {
  RateOverridesCard,
  type RateOverrideRow,
} from "./_components/rate-overrides-card";
import { DeleteCoachCard } from "./_components/delete-coach-card";
import { CoachPaymentsCard } from "./_components/coach-payments-card";
import { CoachHandlesCard } from "./_components/handles-card";

// Coach detail page. Renders the coach identity header + the H3
// rate-override editor (one row per resource type, inline save +
// remove).

const ALL_RESOURCE_TYPES: ResourceType[] = ["cage", "bullpen", "weight_room"];

type Params = Promise<{ id: string }>;

export default async function AdminCoachDetailPage({
  params,
}: {
  params: Params;
}) {
  await requireRole("admin");
  const { id } = await params;

  const [coachResult, overrideRows, sessionRows, paymentRows] =
    await Promise.all([
      db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          role: users.role,
          createdAt: users.createdAt,
          venmoHandle: users.venmoHandle,
          zelleContact: users.zelleContact,
        })
        .from(users)
        .where(and(eq(users.id, id), isNull(users.deletedAt)))
        .limit(1),
      db
        .select()
        .from(coachRateOverrides)
        .where(eq(coachRateOverrides.coachId, id)),
      // Sessions feed for the balance: this coach's lifetime rentals
      // joined to resources for the resource type → charge math.
      db
        .select({
          resourceType: resources.type,
          startAt: sessionsBilling.startAt,
          endAt: sessionsBilling.endAt,
        })
        .from(sessionsBilling)
        .innerJoin(resources, eq(sessionsBilling.resourceId, resources.id))
        .where(eq(sessionsBilling.coachId, id)),
      // Payment history (confirmed + pending) for the per-coach
      // ledger card. Soft-deleted rows are excluded.
      db
        .select({
          id: coachPayments.id,
          amountCents: coachPayments.amountCents,
          method: coachPayments.method,
          paidAt: coachPayments.paidAt,
          reference: coachPayments.reference,
          note: coachPayments.note,
          status: coachPayments.status,
        })
        .from(coachPayments)
        .where(
          and(
            eq(coachPayments.coachId, id),
            isNull(coachPayments.deletedAt),
          ),
        )
        .orderBy(desc(coachPayments.paidAt)),
    ]);

  const coach = coachResult[0];
  // Active coaches only: soft-deleted (deletedAt != null) rows behave
  // like notFound() in admin navigation. Admins are still 404'd here
  // because /admin/coaches lists role=coach only and the URL is
  // surrogate-id; landing on an admin's detail page would be a stale
  // bookmark.
  if (!coach || coach.role !== "coach") notFound();

  // Always render one row per resource type; merge in the override
  // when present. The client component decides save-vs-create based
  // on whether `override` is null.
  const overrideByType = new Map(
    overrideRows.map((o) => [o.resourceType, o]),
  );
  // Per-coach balance math: same rules as /admin/payments —
  // confirmed payments reduce the owed total, pending stays separate.
  const overrideMap: RateOverride[] = overrideRows.map((o) => ({
    coachId: o.coachId,
    resourceType: o.resourceType,
    ratePer30MinCents: o.ratePer30MinCents,
  }));
  let owedCents = 0;
  for (const s of sessionRows) {
    const charge = chargeForSession(
      {
        coachId: id,
        resourceType: s.resourceType as ResourceType,
        startAt: s.startAt,
        endAt: s.endAt,
      },
      overrideMap,
    );
    owedCents += charge.totalCents;
  }
  const confirmedPaidCents = paymentRows
    .filter((p) => p.status === "confirmed")
    .reduce((sum, p) => sum + p.amountCents, 0);
  const pendingCents = paymentRows
    .filter((p) => p.status === "pending")
    .reduce((sum, p) => sum + p.amountCents, 0);

  const rateRows: RateOverrideRow[] = ALL_RESOURCE_TYPES.map((rt) => {
    const o = overrideByType.get(rt);
    return {
      resourceType: rt,
      defaultCents: DEFAULT_RATES_PER_SLOT_CENTS[rt],
      override: o
        ? { ratePer30MinCents: o.ratePer30MinCents, updatedAt: o.updatedAt }
        : null,
    };
  });

  return (
    <>
      <Link
        href="/admin/coaches"
        className="inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg mb-6 transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        All coaches
      </Link>

      <div className="space-y-1.5 mb-6">
        <p className="text-xs uppercase tracking-[0.18em] text-fg-muted">
          Coach
        </p>
        <h1 className="text-2xl font-bold tracking-tight">
          {coach.name ?? coach.email}
        </h1>
        <p className="text-sm text-fg-muted">{coach.email}</p>
        <p className="text-xs text-fg-subtle font-mono tabular-nums">
          Joined {formatPfaDateMedium(coach.createdAt)}
        </p>
      </div>

      <RateOverridesCard coachId={coach.id} rows={rateRows} />

      <CoachHandlesCard
        coachId={coach.id}
        initialVenmoHandle={coach.venmoHandle}
        initialZelleContact={coach.zelleContact}
      />

      <CoachPaymentsCard
        coachId={coach.id}
        owedCents={owedCents}
        paidCents={confirmedPaidCents}
        pendingCents={pendingCents}
        payments={paymentRows}
      />

      <DeleteCoachCard
        coachId={coach.id}
        coachName={coach.name}
        coachEmail={coach.email}
        isAdmin={false}
      />
    </>
  );
}
