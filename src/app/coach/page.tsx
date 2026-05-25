import Link from "next/link";
import { and, eq, gte, lt, sql as drizzleSql } from "drizzle-orm";
import {
  ArrowUpRight,
  CalendarDays,
  CalendarPlus,
  ClipboardList,
  Coins,
} from "lucide-react";
import { db } from "@/db";
import {
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

// /coach landing. J4e: real-data dashboard mirror of /admin. Two
// numbers — sessions logged this month, total owed — plus the two
// actions a coach actually does (log a new session, review history).
//
// Coach can only see their OWN data here. The WHERE clause on
// coachId enforces it server-side; URL-guessing another coach's
// totals is moot.

export default async function CoachHome() {
  const session = await requireSession();
  const coachId = session.user.id;
  const displayName =
    session.user.name ?? session.user.email?.split("@")[0] ?? "Coach";

  const now = new Date();
  const monthStart = pfaMonthStart(now);
  const monthEndExclusive = pfaMonthEnd(now);

  const [monthSessionRows, overrideRows, [{ count: totalEver }]] =
    await Promise.all([
      db
        .select({
          coachId: sessionsBilling.coachId,
          resourceType: resources.type,
          startAt: sessionsBilling.startAt,
          endAt: sessionsBilling.endAt,
        })
        .from(sessionsBilling)
        .innerJoin(resources, eq(sessionsBilling.resourceId, resources.id))
        .where(
          and(
            eq(sessionsBilling.coachId, coachId),
            gte(sessionsBilling.startAt, monthStart),
            lt(sessionsBilling.startAt, monthEndExclusive),
          ),
        ),
      db
        .select()
        .from(coachRateOverrides)
        .where(eq(coachRateOverrides.coachId, coachId)),
      db
        .select({ count: drizzleSql<number>`count(*)::int` })
        .from(sessionsBilling)
        .where(eq(sessionsBilling.coachId, coachId)),
    ]);

  const overrides: RateOverride[] = overrideRows.map((o) => ({
    coachId: o.coachId,
    resourceType: o.resourceType,
    ratePer30MinCents: o.ratePer30MinCents,
  }));
  let monthCents = 0;
  for (const s of monthSessionRows) {
    const charge = chargeForSession(
      {
        coachId: s.coachId,
        resourceType: s.resourceType as ResourceType,
        startAt: s.startAt,
        endAt: s.endAt,
      },
      overrides,
    );
    monthCents += charge.totalCents;
  }
  const monthCount = monthSessionRows.length;

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
          icon={<Coins className="h-4 w-4" />}
          label="Total this month"
          value={formatDollars(monthCents)}
          sub="Based on your current rates"
          accent
        />
      </section>

      <div className="grid gap-3 sm:grid-cols-2">
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
          body="Review history, fix a slot, see your totals."
        />
      </div>
    </div>
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

function formatDollars(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}
