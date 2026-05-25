import Link from "next/link";
import { and, eq, gte, isNull, lt, sql as drizzleSql } from "drizzle-orm";
import {
  ArrowUpRight,
  CalendarDays,
  CalendarPlus,
  ClipboardList,
  Clock,
  Wallet,
} from "lucide-react";
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
import {
  formatPfaDateLong,
  formatPfaMonthYear,
  pfaMonthEnd,
  pfaMonthStart,
} from "@/lib/timezone";
import { EditableName } from "../_components/editable-name";

// /coach landing. Two stat tiles + three actions (log a new session,
// review history, payments). The Payments card surfaces the coach's
// own balance — flips the original "no dollar amounts" rule, which
// only ever held until the V2 invoice surface shipped. See
// project_coach_rate_visibility memory for the rule update.
//
// Coach can only see their OWN data here. The WHERE clause on
// coachId enforces it server-side; URL-guessing another coach's
// numbers is moot.

export default async function CoachHome() {
  const session = await requireSession();
  const coachId = session.user.id;
  const displayName =
    session.user.name ?? session.user.email?.split("@")[0] ?? "Coach";

  const now = new Date();
  const monthStart = pfaMonthStart(now);
  const monthEndExclusive = pfaMonthEnd(now);

  const [
    monthSessionRows,
    [{ count: totalEver }],
    allRentalRows,
    overrideRows,
    confirmedPaymentRows,
  ] = await Promise.all([
    db
      .select({
        startAt: sessionsBilling.startAt,
        endAt: sessionsBilling.endAt,
      })
      .from(sessionsBilling)
      .where(
        and(
          eq(sessionsBilling.coachId, coachId),
          gte(sessionsBilling.startAt, monthStart),
          lt(sessionsBilling.startAt, monthEndExclusive),
        ),
      ),
    db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(sessionsBilling)
      .where(eq(sessionsBilling.coachId, coachId)),
    // Balance feed for the Payments card: all of this coach's
    // sessions, joined to resources for the rate calculation.
    db
      .select({
        resourceType: resources.type,
        startAt: sessionsBilling.startAt,
        endAt: sessionsBilling.endAt,
      })
      .from(sessionsBilling)
      .innerJoin(resources, eq(sessionsBilling.resourceId, resources.id))
      .where(eq(sessionsBilling.coachId, coachId)),
    db
      .select()
      .from(coachRateOverrides)
      .where(eq(coachRateOverrides.coachId, coachId)),
    db
      .select({ amountCents: coachPayments.amountCents })
      .from(coachPayments)
      .where(
        and(
          eq(coachPayments.coachId, coachId),
          eq(coachPayments.status, "confirmed"),
          isNull(coachPayments.deletedAt),
        ),
      ),
  ]);

  const monthCount = monthSessionRows.length;
  const monthMinutes = monthSessionRows.reduce(
    (sum, s) => sum + (s.endAt.getTime() - s.startAt.getTime()) / 60_000,
    0,
  );

  // Coach's own balance for the Payments card. Same math as
  // /coach/payments — every rental minus confirmed payments. Pending
  // entries don't reduce here (Dad has to confirm first).
  const overrides: RateOverride[] = overrideRows.map((o) => ({
    coachId: o.coachId,
    resourceType: o.resourceType,
    ratePer30MinCents: o.ratePer30MinCents,
  }));
  let owedCents = 0;
  for (const r of allRentalRows) {
    const charge = chargeForSession(
      {
        coachId,
        resourceType: r.resourceType as ResourceType,
        startAt: r.startAt,
        endAt: r.endAt,
      },
      overrides,
    );
    owedCents += charge.totalCents;
  }
  const paidCents = confirmedPaymentRows.reduce(
    (sum, p) => sum + p.amountCents,
    0,
  );
  const balanceCents = owedCents - paidCents;

  return (
    <div className="max-w-2xl">
      <header className="mb-10">
        <p className="text-xs uppercase tracking-[0.18em] text-fg-muted">
          {formatPfaDateLong(now)}
        </p>
        <h1 className="mt-2 text-2xl sm:text-3xl font-bold tracking-tight break-words">
          <EditableName initialName={displayName} />
        </h1>
      </header>

      <section
        aria-label="This month"
        className="mb-10 grid gap-px rounded-xl border border-line bg-line overflow-hidden sm:grid-cols-2"
      >
        <Stat
          icon={<CalendarDays className="h-4 w-4" />}
          label={`Sessions in ${formatPfaMonthYear(now)}`}
          value={monthCount.toString()}
          sub={
            monthCount === 0
              ? "Log your first one below"
              : `${totalEver} all-time`
          }
        />
        <Stat
          icon={<Clock className="h-4 w-4" />}
          label={`Hours in ${formatPfaMonthYear(now)}`}
          value={formatHours(monthMinutes)}
          sub={
            monthMinutes === 0
              ? "—"
              : "Sum of your logged session durations"
          }
          accent
        />
      </section>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <NavCard
          href="/coach/sessions/new"
          icon={<CalendarPlus className="h-4 w-4" />}
          title="Log a session"
          body="Date, time, resource, optional note."
        />
        <NavCard
          href="/coach/sessions"
          icon={<ClipboardList className="h-4 w-4" />}
          title="My sessions"
          body="Review history, fix a slot."
        />
        <NavCard
          href="/coach/payments"
          icon={<Wallet className="h-4 w-4" />}
          title="Payments"
          body={
            balanceCents <= 0
              ? "All settled."
              : `You owe ${formatDollars(balanceCents)}.`
          }
        />
      </div>
    </div>
  );
}

function formatDollars(cents: number): string {
  const dollars = (cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `$${dollars}`;
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
          "mt-3 font-mono tabular-nums tracking-tight text-3xl",
          accent ? "text-gold" : "text-fg",
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
  body,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  body: string;
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
      <p className="mt-1.5 text-xs text-fg-muted">{body}</p>
    </Link>
  );
}

function formatHours(minutes: number): string {
  // 1.5h instead of "1 hr 30 min" — fits the big-numeric stat-tile aesthetic.
  const h = minutes / 60;
  return h % 1 === 0 ? `${h}` : h.toFixed(1);
}
