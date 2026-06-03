import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import { db } from "@/db";
import {
  coachPayments,
  coachRateOverrides,
  programRateOverrides,
  programs,
  sessionsBilling,
  users,
} from "@/db/schema";
import { requireRole } from "@/lib/authz";
import {
  DEFAULT_RATES_PER_SLOT_CENTS,
  totalFromSnapshot,
  type ResourceType,
} from "@/lib/billing";
import { formatPfaDateMedium } from "@/lib/timezone";
import {
  RateOverridesCard,
  type RateOverrideRow,
} from "./_components/rate-overrides-card";
import {
  ProgramRateOverridesCard,
  type ProgramRateOverrideRow,
} from "./_components/program-rate-overrides-card";
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

  const [
    coachResult,
    overrideRows,
    sessionRows,
    paymentRows,
    programRows,
    programOverrideRows,
  ] = await Promise.all([
      db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          role: users.role,
          createdAt: users.createdAt,
          phone: users.phone,
          zelleContact: users.zelleContact,
        })
        .from(users)
        .where(and(eq(users.id, id), isNull(users.deletedAt)))
        .limit(1),
      db
        .select()
        .from(coachRateOverrides)
        .where(eq(coachRateOverrides.coachId, id)),
      // Sessions feed for the balance: this coach's lifetime rentals.
      // Reads the snapshotted ratePer30MinCents per row so past sessions
      // hold their historical rate even if the override has since changed.
      db
        .select({
          startAt: sessionsBilling.startAt,
          endAt: sessionsBilling.endAt,
          ratePer30MinCents: sessionsBilling.ratePer30MinCents,
        })
        .from(sessionsBilling)
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
      // Active programs (for the per-coach Program rates card): one row
      // per active program, with its default pay rate.
      db
        .select({
          id: programs.id,
          name: programs.name,
          defaultRatePer30MinCents: programs.defaultRatePer30MinCents,
        })
        .from(programs)
        .where(eq(programs.active, true))
        .orderBy(asc(programs.name)),
      // This coach's program rate overrides, keyed on (coach, program).
      db
        .select()
        .from(programRateOverrides)
        .where(eq(programRateOverrides.coachId, id)),
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
  // Reads each session's snapshotted rate directly.
  let owedCents = 0;
  for (const s of sessionRows) {
    owedCents += totalFromSnapshot(s.startAt, s.endAt, s.ratePer30MinCents);
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

  // One row per ACTIVE program; merge in this coach's override when set.
  const programOverrideByProgram = new Map(
    programOverrideRows.map((o) => [o.programId, o]),
  );
  const programRateRows: ProgramRateOverrideRow[] = programRows.map((p) => {
    const o = programOverrideByProgram.get(p.id);
    return {
      programId: p.id,
      programName: p.name,
      defaultCents: p.defaultRatePer30MinCents,
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
        <p className="text-[11.5px] font-semibold uppercase tracking-[0.14em] text-fg-muted">
          Coach
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          {coach.name ?? coach.email}
        </h1>
        <p className="text-sm text-fg-muted">{coach.email}</p>
        <p className="text-sm text-fg-muted">
          Phone: {coach.phone ?? "—"}
        </p>
        <p className="text-xs text-fg-subtle font-mono tnum tabular-nums">
          Joined {formatPfaDateMedium(coach.createdAt)}
        </p>
      </div>

      <RateOverridesCard coachId={coach.id} rows={rateRows} />

      <ProgramRateOverridesCard
        coachId={coach.id}
        rows={programRateRows}
      />

      <CoachHandlesCard
        coachId={coach.id}
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
