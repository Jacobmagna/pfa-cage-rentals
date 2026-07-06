import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, desc, eq, inArray, isNull, like, or } from "drizzle-orm";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { db } from "@/db";
import {
  auditLog,
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
import { CoachNotesCard } from "./_components/notes-card";
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
import { RestoreCoachCard } from "./_components/restore-coach-card";
import { CoachPaymentsCard } from "./_components/coach-payments-card";
import { CoachHandlesCard } from "./_components/handles-card";
import { ScheduleManagerCard } from "./_components/schedule-manager-card";

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
          scheduleAdmin: users.scheduleAdmin,
          smsOptIn: users.smsOptIn,
          smsConsentAt: users.smsConsentAt,
          smsOptOut: users.smsOptOut,
          deletedAt: users.deletedAt,
        })
        .from(users)
        // QA-2: no longer gated on isNull(deletedAt). Archived coaches now
        // RENDER here in READ-ONLY mode (isArchived below drives it). The
        // page is a lossless read-only window into a soft-deleted coach —
        // every editor is disabled and the danger card becomes Restore.
        .where(eq(users.id, id))
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
  // Admins are still 404'd here because /admin/coaches lists role=coach
  // only and the URL is surrogate-id; landing on an admin's detail page
  // would be a stale bookmark. QA-2: soft-deleted (deletedAt != null)
  // coaches are NO LONGER 404'd — they render read-only (isArchived).
  if (!coach || coach.role !== "coach") notFound();

  // QA-2: an archived coach still resolves (the gate above was relaxed),
  // so drive a fully READ-ONLY render. Every editor card is disabled and
  // the danger-zone Archive card is swapped for Restore. The server-side
  // write guards in actions.ts are the real enforcement; readOnly here is
  // the matching UI.
  const isArchived = coach.deletedAt !== null;

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
      // Weight-room GROUP rate override. Only meaningful for weight_room;
      // for cage/bullpen it's carried as null and the card ignores it.
      groupRatePer30MinCents: o?.groupRatePer30MinCents ?? null,
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
        ? {
            payMode: o.payMode,
            ratePer30MinCents: o.ratePer30MinCents,
            perSessionRateCents: o.perSessionRateCents,
            updatedAt: o.updatedAt,
          }
        : null,
    };
  });

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

    // Pull the rate snapshot out of the diff's before/after. A PER-SESSION
    // program override (DESIGN-1) stamps ratePer30MinCents = null and puts the
    // money in perSessionRateCents, so we must read both keys.
    const diff = (r.diff ?? {}) as {
      before?: { ratePer30MinCents?: number; perSessionRateCents?: number } | null;
      after?: { ratePer30MinCents?: number; perSessionRateCents?: number } | null;
    };

    // Weight room resource overrides are DISPLAYED per HOUR (cents × 2),
    // like program rates; cages & bullpens stay per 30 min.
    const isHourly = isProgram || suffix === "weight_room";
    const fmtSnap = (
      snap: { ratePer30MinCents?: number; perSessionRateCents?: number } | null | undefined,
    ): string | null => {
      if (!snap) return null;
      // Per-session is a FLAT amount → cents/100 with "/ session" (no ×2).
      if (snap.perSessionRateCents != null) {
        return `$${(snap.perSessionRateCents / 100).toFixed(2)} / session`;
      }
      if (snap.ratePer30MinCents != null) {
        return isHourly
          ? `$${((snap.ratePer30MinCents * 2) / 100).toFixed(2)} / hr`
          : `$${(snap.ratePer30MinCents / 100).toFixed(2)} / 30 min`;
      }
      return null;
    };

    return {
      id: r.id,
      action: r.action,
      target,
      kind,
      beforeLabel: fmtSnap(diff.before),
      afterLabel: fmtSnap(diff.after),
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
          {isArchived ? (
            <span className="ml-2.5 align-middle inline-flex items-center rounded-full bg-surface-2 text-fg-muted ring-1 ring-inset ring-line px-2 py-0.5 text-xs font-medium uppercase tracking-wider">
              Archived
            </span>
          ) : null}
        </h1>
        <p className="text-sm text-fg-muted">{coach.email}</p>
        <p className="text-sm text-fg-muted">
          Phone: {coach.phone ?? "—"}
        </p>
        <p className="text-xs text-fg-subtle font-mono tnum tabular-nums">
          Joined {formatPfaDateMedium(coach.createdAt)}
        </p>
      </div>

      {/* QA-2: read-only notice for an archived coach. Explains WHY every
          editor below is disabled and points to Restore at the bottom. */}
      {isArchived ? (
        <div className="mb-6 rounded-xl border border-line bg-surface-2/60 px-4 py-3 text-xs text-fg-muted leading-relaxed">
          This coach is archived, so this page is <span className="text-fg font-medium">read-only</span>.
          Their past rentals, work hours, and billing are all preserved below.
          Restore them from the panel at the bottom to make changes again.
        </div>
      ) : null}

      {/* QA-2: deep-links into the EXISTING filterable list pages, pre-scoped
          to this coach. /admin/sessions reads `coachIds`; /admin/hour-log
          reads `coachId`. Shown for every coach (handy shortcut), and the
          only way to reach this coach's rows while archived. */}
      <div className="mb-6 flex flex-wrap gap-2">
        <Link
          href={`/admin/sessions?coachIds=${coach.id}`}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong bg-surface text-fg-muted hover:text-fg hover:-translate-y-px shadow-[var(--shadow-sm)] hover:shadow-[var(--shadow-md)] h-9 px-3 text-xs font-medium transition"
        >
          See all cage rentals
          <ArrowUpRight className="h-3.5 w-3.5" />
        </Link>
        <Link
          href={`/admin/hour-log?coachId=${coach.id}`}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong bg-surface text-fg-muted hover:text-fg hover:-translate-y-px shadow-[var(--shadow-sm)] hover:shadow-[var(--shadow-md)] h-9 px-3 text-xs font-medium transition"
        >
          See all work hours
          <ArrowUpRight className="h-3.5 w-3.5" />
        </Link>
      </div>

      <RateOverridesCard
        coachId={coach.id}
        rows={rateRows}
        readOnly={isArchived}
      />

      <ProgramRateOverridesCard
        coachId={coach.id}
        rows={programRateRows}
        readOnly={isArchived}
      />

      <RateHistoryCard rows={rateHistoryRows} />

      <CoachNotesCard
        coachId={coach.id}
        initialNotes={coach.notes}
        readOnly={isArchived}
      />

      <ScheduleManagerCard
        coachId={coach.id}
        initialEnabled={coach.scheduleAdmin}
        readOnly={isArchived}
      />

      <CoachHandlesCard
        coachId={coach.id}
        initialZelleContact={coach.zelleContact}
        readOnly={isArchived}
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

      {/* QA-2: Archive danger card when active; Restore panel when archived.
          Restore is the ONE mutation allowed on an archived coach. */}
      {isArchived ? (
        <RestoreCoachCard coachId={coach.id} coachName={coach.name} />
      ) : (
        <DeleteCoachCard
          coachId={coach.id}
          coachName={coach.name}
          coachEmail={coach.email}
          isAdmin={false}
        />
      )}
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
