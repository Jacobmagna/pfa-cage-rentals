import { and, gte, lt, sql as drizzleSql } from "drizzle-orm";
import {
  CalendarDays,
  ClipboardList,
  Coins,
} from "lucide-react";
import { db } from "@/db";
import { blockedTimes, sessionsBilling } from "@/db/schema";
import { requireRole } from "@/lib/authz";
import { EditableName } from "@/app/_components/editable-name";
import { NavCard } from "@/app/_components/nav-card";
import { StatCard } from "@/app/_components/stat-card";
import { totalFromSnapshot } from "@/lib/billing";
import { formatDollars } from "@/lib/format-money";
import {
  formatPfaDateLong,
  formatPfaMonthYear,
  pfaDayEnd,
  pfaDayStart,
  pfaMonthEnd,
  pfaMonthStart,
} from "@/lib/timezone";

// /admin/cage-rentals dashboard. J4e: real-data dashboard pattern. Three
// small queries hydrate a stats hero (today's sessions, this month's
// billing, today's blocks), then a single Operations nav grid links the
// cage-specific surfaces (Schedule, Sessions). Org-record surfaces
// (Coaches, Reports, Payments, Audit log, Import, Settings) now live under
// the top-level Billing & Records tab at /admin/records (QA5).
//
// All counts are server-rendered + revalidated on every visit (no
// cache: 'force-dynamic' needed — these are inside a server component
// that already opts out of static caching via the auth check).
//
// Snapshot rule: month total reads sessionsBilling.ratePer30MinCents
// directly. Renegotiating an override changes future bookings only.

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
  ]);

  // Month total reads the snapshotted rate from each session row directly.
  // Same shape as /admin/reports — never recompute from current overrides.
  let monthCents = 0;
  for (const s of monthSessionRows) {
    monthCents += totalFromSnapshot(s.startAt, s.endAt, s.ratePer30MinCents);
  }

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
        className="mb-12 grid gap-4 sm:grid-cols-3"
      >
        <StatCard
          icon={<CalendarDays className="h-4 w-4" />}
          label="Rentals today"
          value={sessionsToday.toString()}
          sub={sessionsToday === 0 ? "Quiet day so far" : "Booked"}
        />
        <StatCard
          icon={<Coins className="h-4 w-4" />}
          label={`Owed in ${formatPfaMonthYear(now)}`}
          value={formatDollars(monthCents)}
          sub={`${monthSessionRows.length} ${monthSessionRows.length === 1 ? "rental" : "rentals"} this month`}
          accent
        />
        <StatCard
          icon={<ClipboardList className="h-4 w-4" />}
          label="Active blocks today"
          value={blocksToday.toString()}
          sub={blocksToday === 0 ? "Cages all bookable" : "Resources held"}
        />
      </section>

      <section aria-labelledby="operations-heading" className="mb-10">
        <h2
          id="operations-heading"
          className="mb-4 text-[11.5px] font-semibold uppercase tracking-[0.14em] text-fg-muted"
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
                : `${sessionsToday} rental${sessionsToday === 1 ? "" : "s"}${blocksToday > 0 ? ` · ${blocksToday} block${blocksToday === 1 ? "" : "s"}` : ""} today`
            }
          />
          <NavCard
            href="/admin/sessions"
            icon={<ClipboardList className="h-4 w-4" />}
            title="Rentals"
            stat="Log, edit, review"
          />
        </div>
      </section>
    </>
  );
}
