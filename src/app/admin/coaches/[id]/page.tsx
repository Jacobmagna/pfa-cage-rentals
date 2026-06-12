import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, desc, eq, inArray, isNull, like, or } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import { db } from "@/db";
import {
  auditLog,
  coachPayments,
  coachPaySettings,
  coachRateOverrides,
  programRateOverrides,
  programs,
  sessionsBilling,
  users,
  type CoachPayMode,
} from "@/db/schema";
import { requireRole } from "@/lib/authz";
import {
  DEFAULT_RATES_PER_SLOT_CENTS,
  totalFromSnapshot,
  type ResourceType,
} from "@/lib/billing";
import { formatPfaDateMedium } from "@/lib/timezone";
import { CoachNotesCard } from "./_components/notes-card";
import { CoachPayModeCard } from "./_components/pay-mode-card";
import {
  RateHistoryCard,
  type RateHistoryRow,
} from "./_components/rate-history-card";
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

// Display labels for resource types in the rate-history timeline. Matches
// the RESOURCE_LABEL map in rate-overrides-card.tsx.
const RESOURCE_LABEL: Record<string, string> = {
  cage: "Cages",
  bullpen: "Bullpens",
  weight_room: "Weight Room",
};

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
    paySettingsResult,
    rateAuditRows,
    allProgramRows,
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
          notes: users.notes,
          smsOptIn: users.smsOptIn,
          smsConsentAt: users.smsConsentAt,
          smsOptOut: users.smsOptOut,
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
          direction: coachPayments.direction,
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
      // QA2 #6 — this coach's work-pay-mode settings (one row, or none →
      // implicit "hourly").
      db
        .select()
        .from(coachPaySettings)
        .where(eq(coachPaySettings.coachId, id))
        .limit(1),
      // QA2 #7 — rate-override change history, derived from the existing
      // audit_log (no new table). Resource-type overrides log with
      // entityType="rate_override" + entityId="${coachId}:${resourceType}";
      // program-rate overrides log with entityType="program_rate_override" +
      // entityId="${coachId}:${programId}". Filter to this coach's entries
      // (entityId starts with "${coachId}:"), newest first. Join users to
      // resolve the actor's display name.
      db
        .select({
          id: auditLog.id,
          entityType: auditLog.entityType,
          entityId: auditLog.entityId,
          action: auditLog.action,
          diff: auditLog.diff,
          ts: auditLog.ts,
          actorName: users.name,
          actorEmail: users.email,
        })
        .from(auditLog)
        .leftJoin(users, eq(users.id, auditLog.actorUserId))
        .where(
          and(
            inArray(auditLog.entityType, [
              "rate_override",
              "program_rate_override",
            ]),
            or(
              like(auditLog.entityId, `${id}:%`),
              eq(auditLog.entityId, id),
            ),
          ),
        )
        .orderBy(desc(auditLog.ts)),
      // All programs (active + retired) so the rate-history timeline can
      // resolve a program name even for an override on a now-inactive program.
      db
        .select({ id: programs.id, name: programs.name })
        .from(programs),
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
    .filter((p) => p.status === "confirmed" && p.direction === "coach_to_pfa")
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

  // QA2 #6 — current pay-mode setting (default "hourly" when no row).
  const paySettings = paySettingsResult[0];
  const payMode: CoachPayMode = paySettings?.payMode ?? "hourly";
  const perSessionRateCents = paySettings?.perSessionRateCents ?? null;

  // QA2 #7 — build the rate-history timeline from the audit rows.
  // The override tables store ratePer30MinCents. Resource (rental) rates
  // are DISPLAYED per 30 min; program (work) rates are DISPLAYED per hour
  // (cents × 2). The diff JSONB shape (see src/lib/audit.ts):
  //   create → { after: <full row> }
  //   update → { before: <changed keys>, after: <changed keys> }  (rate only)
  //   delete → { before: <full row> }
  const programNameById = new Map(allProgramRows.map((p) => [p.id, p.name]));

  const rateHistoryRows: RateHistoryRow[] = rateAuditRows.map((r) => {
    const isProgram = r.entityType === "program_rate_override";
    // entityId is "${coachId}:${suffix}" — the suffix is the resourceType
    // (rate_override) or the programId (program_rate_override).
    const suffix = r.entityId.startsWith(`${id}:`)
      ? r.entityId.slice(id.length + 1)
      : "";
    const target = isProgram
      ? (programNameById.get(suffix) ?? "Unknown program")
      : (RESOURCE_LABEL[suffix] ?? suffix);
    const kind = isProgram ? "Work rate" : "Rental rate";

    // Pull the per-30-min cents out of the diff's before/after snapshots.
    const diff = (r.diff ?? {}) as {
      before?: { ratePer30MinCents?: number } | null;
      after?: { ratePer30MinCents?: number } | null;
    };
    const beforeCents = diff.before?.ratePer30MinCents ?? null;
    const afterCents = diff.after?.ratePer30MinCents ?? null;

    const fmt = (cents: number | null): string | null =>
      cents == null
        ? null
        : isProgram
          ? `$${((cents * 2) / 100).toFixed(2)} / hr`
          : `$${(cents / 100).toFixed(2)} / 30 min`;

    return {
      id: r.id,
      action: r.action,
      target,
      kind,
      beforeLabel: fmt(beforeCents),
      afterLabel: fmt(afterCents),
      ts: r.ts,
      actor: r.actorName ?? r.actorEmail ?? "—",
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

      <CoachPayModeCard
        coachId={coach.id}
        initialPayMode={payMode}
        initialPerSessionRateCents={perSessionRateCents}
      />

      <RateHistoryCard rows={rateHistoryRows} />

      <CoachNotesCard coachId={coach.id} initialNotes={coach.notes} />

      <CoachHandlesCard
        coachId={coach.id}
        initialZelleContact={coach.zelleContact}
      />

      <SmsReminderStatus
        optIn={coach.smsOptIn}
        optOut={coach.smsOptOut}
        phone={coach.phone}
        consentAt={coach.smsConsentAt}
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

// 1b #25 — READ-ONLY SMS-reminder status. Admins can SEE whether a coach
// opted in (and their phone + consent date) but cannot toggle it here:
// SMS consent is the coach's own deliberate choice (Twilio A2P requires
// the recipient to opt in), so this surface is purely informational. The
// coach manages it from /coach.
function SmsReminderStatus({
  optIn,
  optOut,
  phone,
  consentAt,
}: {
  optIn: boolean;
  optOut: boolean;
  phone: string | null;
  consentAt: Date | null;
}) {
  // optOut (carrier STOP) overrides an opt-in: the coach won't receive
  // texts even if smsOptIn is still true.
  const reminders = optIn && !optOut ? "On" : "Off";
  return (
    <section className="my-8 rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)] overflow-hidden">
      <header className="px-5 py-4 border-b border-line">
        <h3 className="text-base font-semibold text-fg">Text reminders</h3>
        <p className="mt-1 text-xs text-fg-muted leading-relaxed">
          Whether this coach opted in to work-log reminder texts. Read-only —
          the coach manages this from their own dashboard.
        </p>
      </header>
      <dl className="p-5 space-y-2 text-sm">
        <div className="flex items-center justify-between gap-3">
          <dt className="text-fg-muted">Reminders</dt>
          <dd className="font-medium text-fg">{reminders}</dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-fg-muted">Phone on file</dt>
          <dd className="font-medium text-fg">{phone ?? "none"}</dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-fg-muted">Consented</dt>
          <dd className="font-medium text-fg">
            {consentAt ? formatPfaDateMedium(consentAt) : "—"}
          </dd>
        </div>
        {optOut ? (
          <div className="flex items-center justify-between gap-3">
            <dt className="text-fg-muted">Carrier opt-out</dt>
            <dd className="font-medium text-danger">Replied STOP</dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}
