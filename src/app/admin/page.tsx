import Link from "next/link";
import { and, eq, gte, isNull, lt, sql as drizzleSql } from "drizzle-orm";
import {
  ArrowUpRight,
  CalendarDays,
  ClipboardList,
  Coins,
  FileText,
  History,
  Settings,
  Upload,
  Users,
  Wallet,
} from "lucide-react";
import { db } from "@/db";
import {
  auditLog,
  blockedTimes,
  coachPayments,
  sessionsBilling,
  users,
} from "@/db/schema";
import { requireRole } from "@/lib/authz";
import { EditableName } from "../_components/editable-name";
import { totalFromSnapshot } from "@/lib/billing";
import {
  formatPfaDateLong,
  formatPfaMonthYear,
  pfaDayEnd,
  pfaDayStart,
  pfaMonthEnd,
  pfaMonthStart,
} from "@/lib/timezone";

// /admin landing. J4e: real-data dashboard pattern. Three small queries
// hydrate a stats hero (today's sessions, this month's billing, today's
// blocks), then a sectioned nav grid groups surfaces by purpose rather
// than dumping six identical cards.
//
// All counts are server-rendered + revalidated on every visit (no
// cache: 'force-dynamic' needed — these are inside a server component
// that already opts out of static caching via the auth check).
//
// Snapshot rule: month + lifetime owed totals read sessionsBilling.ratePer30MinCents
// directly. Renegotiating an override changes future bookings only.

const ACTIVE_COACH_FILTER = and(
  eq(users.role, "coach"),
  isNull(users.deletedAt),
);

export default async function AdminHome() {
  const session = await requireRole("admin");

  const now = new Date();
  const dayStart = pfaDayStart(now);
  const dayEnd = pfaDayEnd(now);
  const monthStart = pfaMonthStart(now);
  const monthEndExclusive = pfaMonthEnd(now);

  const [
    [{ count: sessionsToday }],
    monthSessionRows,
    [{ count: blocksToday }],
    [{ count: activeCoaches }],
    [{ ts: lastAuditTs }],
    allSessionsForBalance,
    confirmedPaymentRows,
    [{ count: pendingPaymentsCount }],
  ] = await Promise.all([
    db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(sessionsBilling)
      .where(
        and(
          gte(sessionsBilling.startAt, dayStart),
          lt(sessionsBilling.startAt, dayEnd),
        ),
      ),
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
    db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(blockedTimes)
      .where(
        and(
          gte(blockedTimes.startAt, dayStart),
          lt(blockedTimes.startAt, dayEnd),
        ),
      ),
    db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(users)
      .where(ACTIVE_COACH_FILTER),
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
          {formatPfaDateLong(now)}
        </p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">
          Welcome back,{" "}
          <EditableName initialName={session.user.name ?? "Admin"} />
        </h1>
      </header>

      <section
        aria-label="Today and this month at a glance"
        className="mb-12 grid gap-px rounded-lg border border-line bg-line overflow-hidden sm:grid-cols-3"
      >
        <Stat
          icon={<CalendarDays className="h-4 w-4" />}
          label="Sessions today"
          value={sessionsToday.toString()}
          sub={sessionsToday === 0 ? "Quiet day so far" : "Booked"}
        />
        <Stat
          icon={<Coins className="h-4 w-4" />}
          label={`Owed in ${formatPfaMonthYear(now)}`}
          value={formatDollars(monthCents)}
          sub={`${monthSessionRows.length} ${monthSessionRows.length === 1 ? "session" : "sessions"} this month`}
          accent
        />
        <Stat
          icon={<ClipboardList className="h-4 w-4" />}
          label="Active blocks today"
          value={blocksToday.toString()}
          sub={blocksToday === 0 ? "Cages all bookable" : "Resources held"}
        />
      </section>

      <section aria-labelledby="operations-heading" className="mb-10">
        <h2
          id="operations-heading"
          className="mb-4 text-xs uppercase tracking-[0.18em] text-fg-muted"
        >
          Operations
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <NavCard
            href="/admin/schedule"
            icon={<CalendarDays className="h-4 w-4" />}
            title="Schedule"
            stat={
              sessionsToday === 0 && blocksToday === 0
                ? "Nothing on today"
                : `${sessionsToday} session${sessionsToday === 1 ? "" : "s"}${blocksToday > 0 ? ` · ${blocksToday} block${blocksToday === 1 ? "" : "s"}` : ""} today`
            }
          />
          <NavCard
            href="/admin/sessions"
            icon={<ClipboardList className="h-4 w-4" />}
            title="Sessions"
            stat="Log, edit, review"
          />
          <NavCard
            href="/admin/coaches"
            icon={<Users className="h-4 w-4" />}
            title="Coaches"
            stat={`${activeCoaches} active`}
          />
        </div>
      </section>

      <section aria-labelledby="billing-heading" className="mb-10">
        <h2
          id="billing-heading"
          className="mb-4 text-xs uppercase tracking-[0.18em] text-fg-muted"
        >
          Billing &amp; records
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <NavCard
            href="/admin/reports"
            icon={<FileText className="h-4 w-4" />}
            title="Reports"
            stat={`${formatDollars(monthCents)} this month`}
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
        </div>
      </section>
    </>
  );
}

function Stat({
  icon,
  label,
  value,
  sub,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  accent?: boolean;
}) {
  return (
    <div className="bg-surface px-5 py-5">
      <div className="flex items-center gap-2 text-fg-muted">
        {icon}
        <p className="text-[11px] uppercase tracking-[0.14em]">{label}</p>
      </div>
      <p
        className={[
          "mt-3 font-mono tabular-nums tracking-tight",
          accent ? "text-3xl text-gold" : "text-3xl text-fg",
        ].join(" ")}
      >
        {value}
      </p>
      <p className="mt-1 text-xs text-fg-subtle">{sub}</p>
    </div>
  );
}

function NavCard({
  href,
  icon,
  title,
  stat,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  stat: string;
}) {
  return (
    <Link
      href={href}
      className="group relative flex flex-col rounded-lg border border-line bg-surface px-5 py-4 transition-colors hover:border-line-strong hover:bg-surface-2 focus-visible:outline-none focus-visible:border-line-strong focus-visible:ring-2 focus-visible:ring-gold/40"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-fg-muted transition-colors group-hover:text-gold">
          {icon}
          <p className="text-sm font-semibold text-fg">{title}</p>
        </div>
        <ArrowUpRight className="h-3.5 w-3.5 text-fg-subtle opacity-0 -translate-x-1 transition-all group-hover:opacity-100 group-hover:translate-x-0 group-hover:text-gold" />
      </div>
      <p className="mt-1.5 text-xs text-fg-muted">{stat}</p>
    </Link>
  );
}

function formatDollars(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
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
