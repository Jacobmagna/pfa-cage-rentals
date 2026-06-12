import { and, eq, gte, isNull, lt, sql as drizzleSql } from "drizzle-orm";
import {
  FileText,
  History,
  Settings,
  ShieldAlert,
  Upload,
  Users,
  Wallet,
} from "lucide-react";
import { db } from "@/db";
import { auditLog, coachPayments, sessionsBilling, users } from "@/db/schema";
import { requireRole } from "@/lib/authz";
import { NavCard } from "@/app/_components/nav-card";
import {
  loadAccountabilityScorecard,
  loadOverdueBalances,
} from "@/lib/server/accountability-data";
import { totalFromSnapshot } from "@/lib/billing";
import { formatDollars } from "@/lib/format-money";
import {
  formatPfaDateLong,
  pfaMonthEnd,
  pfaMonthStart,
} from "@/lib/timezone";

// /admin/records — Billing & Records landing (QA5). Holds the org-record
// surfaces that aren't cage-rental-specific: Coaches, Reports, Payments,
// Audit log, Historical import, Settings. Moved off the Cage Rentals
// dashboard so cage Operations stays focused on Schedule + Sessions.
//
// Each NavCard's stat is server-rendered from the same queries the old cage
// dashboard cards used — no behavior change, just relocated.
//
// Snapshot rule: month + lifetime owed totals read
// sessionsBilling.ratePer30MinCents directly. Renegotiating an override
// changes future bookings only.

const ACTIVE_COACH_FILTER = and(
  eq(users.role, "coach"),
  isNull(users.deletedAt),
);

export default async function BillingRecordsHome() {
  await requireRole("admin");

  const now = new Date();
  const monthStart = pfaMonthStart(now);
  const monthEndExclusive = pfaMonthEnd(now);

  const [
    [{ count: activeCoaches }],
    monthSessionRows,
    [{ ts: lastAuditTs }],
    allSessionsForBalance,
    confirmedPaymentRows,
    [{ count: pendingPaymentsCount }],
    accountability,
    overdueBalances,
  ] = await Promise.all([
    db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(users)
      .where(ACTIVE_COACH_FILTER),
    db
      .select({
        startAt: sessionsBilling.startAt,
        endAt: sessionsBilling.endAt,
        ratePer30MinCents: sessionsBilling.ratePer30MinCents,
      })
      .from(sessionsBilling)
      .where(
        and(
          gte(sessionsBilling.startAt, monthStart),
          lt(sessionsBilling.startAt, monthEndExclusive),
        ),
      ),
    // neon-http returns SQL aggregates as strings, not Date objects.
    // The caller wraps in `new Date()` before formatting.
    db
      .select({ ts: drizzleSql<string | null>`max(ts)` })
      .from(auditLog),
    // Balance feed for the Payments NavCard: lifetime owed (rentals)
    // minus lifetime confirmed payments. Same all-time scope as
    // /admin/payments — keeps the NavCard's number consistent with
    // what Dad sees on the detail page.
    db
      .select({
        startAt: sessionsBilling.startAt,
        endAt: sessionsBilling.endAt,
        ratePer30MinCents: sessionsBilling.ratePer30MinCents,
      })
      .from(sessionsBilling),
    db
      .select({
        amountCents: coachPayments.amountCents,
      })
      .from(coachPayments)
      .where(
        and(
          isNull(coachPayments.deletedAt),
          eq(coachPayments.status, "confirmed"),
          eq(coachPayments.direction, "coach_to_pfa"),
        ),
      ),
    db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(coachPayments)
      .where(
        and(
          isNull(coachPayments.deletedAt),
          eq(coachPayments.status, "pending"),
        ),
      ),
    loadAccountabilityScorecard(),
    loadOverdueBalances(),
  ]);

  // Month + lifetime totals read the snapshotted rate from each session
  // row directly. Same shape as /admin/reports — never recompute from
  // current overrides.
  let monthCents = 0;
  for (const s of monthSessionRows) {
    monthCents += totalFromSnapshot(s.startAt, s.endAt, s.ratePer30MinCents);
  }

  let lifetimeOwedCents = 0;
  for (const s of allSessionsForBalance) {
    lifetimeOwedCents += totalFromSnapshot(
      s.startAt,
      s.endAt,
      s.ratePer30MinCents,
    );
  }
  const lifetimePaidCents = confirmedPaymentRows.reduce(
    (sum, p) => sum + p.amountCents,
    0,
  );
  const outstandingCents = lifetimeOwedCents - lifetimePaidCents;

  return (
    <>
      <header className="mb-10">
        <p className="text-xs uppercase tracking-[0.18em] text-fg-muted">
          Admin
        </p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">
          Billing &amp; Records
        </h1>
        <p className="mt-1 text-sm text-fg-muted">
          Coaches, payments, reports, and org records.
        </p>
      </header>

      <section
        aria-label="Billing and records sections"
        className="mb-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
      >
        <NavCard
          href="/admin/coaches"
          icon={<Users className="h-4 w-4" />}
          title="Coaches"
          stat={`${activeCoaches} active`}
        />
        <NavCard
          href="/admin/records/accountability"
          icon={<ShieldAlert className="h-4 w-4" />}
          title="Accountability"
          stat={accountabilityStat(
            accountability.totals.coachesFlagged,
            overdueBalances.count,
          )}
        />
        <NavCard
          href="/admin/reports"
          icon={<FileText className="h-4 w-4" />}
          title="Reports"
          stat={`${formatDollars(monthCents)} this month`}
        />
        <NavCard
          href="/admin/payments"
          icon={<Wallet className="h-4 w-4" />}
          title="Payments"
          stat={
            pendingPaymentsCount > 0
              ? `${formatDollars(outstandingCents)} outstanding · ${pendingPaymentsCount} to confirm`
              : `${formatDollars(outstandingCents)} outstanding`
          }
        />
        <NavCard
          href="/admin/audit"
          icon={<History className="h-4 w-4" />}
          title="Audit log"
          stat={
            lastAuditTs
              ? `Last entry ${formatRelative(new Date(lastAuditTs), now)}`
              : "No activity yet"
          }
        />
        <NavCard
          href="/admin/import"
          icon={<Upload className="h-4 w-4" />}
          title="Historical import"
          stat="Excel → preview → commit"
        />
        <NavCard
          href="/admin/settings"
          icon={<Settings className="h-4 w-4" />}
          title="Settings"
          stat="PFA handles, org-wide config"
        />
      </section>
    </>
  );
}

// Accountability NavCard stat: behavioral flags and overdue cage balances
// are distinct signals, so surface both. "All on track" only when neither.
function accountabilityStat(flagged: number, overdue: number): string {
  const parts: string[] = [];
  if (flagged > 0) parts.push(`${flagged} flagged`);
  if (overdue > 0) parts.push(`${overdue} overdue`);
  return parts.length > 0 ? parts.join(" · ") : "All on track";
}

function formatRelative(then: Date, now: Date): string {
  const diffMs = now.getTime() - then.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return formatPfaDateLong(then);
}
