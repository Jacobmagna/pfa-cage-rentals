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
import { coachPayments, sessionsBilling, users } from "@/db/schema";
import { requireSession } from "@/lib/authz";
import { totalFromSnapshot } from "@/lib/billing";
import {
  formatPfaDateLong,
  formatPfaMonthYear,
  pfaMonthEnd,
  pfaMonthStart,
} from "@/lib/timezone";
import { EditableName } from "../_components/editable-name";
import { SmsReminderCard } from "./_components/sms-reminder-card";

// /coach landing. Two stat tiles + the two actions a coach actually
// does (log a new session, review history). The /coach/payments
// surface (with PAY buttons) was built then removed 2026-05-25 — Dad
// doesn't want coaches PAYING through the app. Backend (coach_payments
// table, admin /admin/payments + /admin/settings) stays in place for
// the admin-side ledger.
//
// #30 (2026-06-08): re-added a READ-ONLY "what you owe PFA for cage
// rentals" balance card below — NO pay buttons, no Venmo/Zelle, just
// the number so a coach can see their balance. Computed exactly like
// the admin Payments page: sum each of THIS coach's sessions_billing
// rows via totalFromSnapshot(start, end, ratePer30MinCents) (cage owed)
// minus their CONFIRMED, non-deleted coach_payments. Cage = coach OWES
// PFA. Program/work pay (PFA → coach, opposite direction) is NOT shown
// here on purpose — mixing directions confuses the balance. Strictly
// coach-scoped to session.user.id; never reads another coach's rows.

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
    allSessionRows,
    confirmedPaymentRows,
    [smsRow],
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
    // Every cage rental THIS coach has ever booked, with its snapshotted
    // rate — for the cage-owed total. (Coach-scoped: coachId only.)
    db
      .select({
        startAt: sessionsBilling.startAt,
        endAt: sessionsBilling.endAt,
        ratePer30MinCents: sessionsBilling.ratePer30MinCents,
      })
      .from(sessionsBilling)
      .where(eq(sessionsBilling.coachId, coachId)),
    // This coach's CONFIRMED, non-deleted payments — matches the admin
    // Payments balance (pending payments don't count yet).
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
    // 1b #25: this coach's own SMS-reminder prefs (coach-scoped to
    // session.user.id) — drives the first-login setup prompt + the
    // compact "Text reminders" settings card.
    db
      .select({
        phone: users.phone,
        smsOptIn: users.smsOptIn,
        smsConsentAt: users.smsConsentAt,
        smsPromptAnsweredAt: users.smsPromptAnsweredAt,
      })
      .from(users)
      .where(eq(users.id, coachId))
      .limit(1),
  ]);

  const monthCount = monthSessionRows.length;
  const monthMinutes = monthSessionRows.reduce(
    (sum, s) => sum + (s.endAt.getTime() - s.startAt.getTime()) / 60_000,
    0,
  );

  // Cage owed (coach OWES PFA) − confirmed payments = balance owed.
  // Same calc as /admin/payments; snapshot rate read off each row so a
  // later rate change never rewrites a past balance.
  const owedCageCents = allSessionRows.reduce(
    (sum, s) => sum + totalFromSnapshot(s.startAt, s.endAt, s.ratePer30MinCents),
    0,
  );
  const paidCents = confirmedPaymentRows.reduce(
    (sum, p) => sum + p.amountCents,
    0,
  );
  const balanceCents = owedCageCents - paidCents;

  return (
    <div className="max-w-2xl mx-auto">
      <header className="mb-10">
        <p className="text-xs uppercase tracking-[0.18em] text-fg-muted">
          {formatPfaDateLong(now)}
        </p>
        <h1 className="mt-2 text-2xl sm:text-3xl font-bold tracking-tight break-words">
          <EditableName initialName={displayName} />
        </h1>
      </header>

      <SmsReminderCard
        initialPhone={smsRow?.phone ?? null}
        initialOptIn={smsRow?.smsOptIn ?? false}
        initialPromptAnswered={smsRow?.smsPromptAnsweredAt != null}
      />

      <section
        aria-label="This month"
        className="mb-10 grid gap-4 sm:grid-cols-2"
      >
        <Stat
          icon={<CalendarDays className="h-4 w-4" />}
          label={`Rentals in ${formatPfaMonthYear(now)}`}
          value={monthCount.toString()}
          sub={
            monthCount === 0
              ? "Log your first one below"
              : `${totalEver} all-time`
          }
        />
        <Stat
          icon={<Clock className="h-4 w-4" />}
          label={`Work hours in ${formatPfaMonthYear(now)}`}
          value={formatHours(monthMinutes)}
          sub={
            monthMinutes === 0
              ? "—"
              : "Sum of your logged rental durations"
          }
          accent
        />
      </section>

      <BalanceCard
        balanceCents={balanceCents}
        owedCageCents={owedCageCents}
        paidCents={paidCents}
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <NavCard
          href="/coach/sessions/new"
          icon={<CalendarPlus className="h-4 w-4" />}
          title="Log a cage rental"
          body="Date, time, resource, optional note."
        />
        <NavCard
          href="/coach/sessions"
          icon={<ClipboardList className="h-4 w-4" />}
          title="My rentals"
          body="Review history, fix a slot."
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
    <div
      className={[
        "relative overflow-hidden rounded-2xl border px-6 py-5 shadow-[var(--shadow-md)] transition hover:-translate-y-0.5 hover:shadow-[var(--shadow-lg)]",
        accent
          ? "border-gold/40 bg-gradient-to-b from-[#fffdf8] to-[#fcf4e2]"
          : "border-line bg-surface",
      ].join(" ")}
    >
      {accent ? (
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-0 w-[3px] bg-gradient-to-b from-gold to-gold-strong"
        />
      ) : null}
      <div
        className={[
          "flex items-center gap-2",
          accent ? "text-gold-strong" : "text-fg-muted",
        ].join(" ")}
      >
        {icon}
        <p className="text-[11px] uppercase tracking-[0.14em] text-fg-muted">
          {label}
        </p>
      </div>
      <p
        className={[
          "tnum mt-4 text-4xl font-semibold tracking-tight",
          accent ? "text-gold-strong" : "text-fg",
        ].join(" ")}
      >
        {value}
      </p>
      <p className="mt-2 text-xs text-fg-subtle">{sub}</p>
    </div>
  );
}

// Read-only cage-rental balance. NO pay buttons by design (#30) — Dad
// doesn't want coaches paying through the app, this just shows the
// number so a coach knows where they stand. Direction is stated
// explicitly: the coach OWES PFA for rentals.
function BalanceCard({
  balanceCents,
  owedCageCents,
  paidCents,
}: {
  balanceCents: number;
  owedCageCents: number;
  paidCents: number;
}) {
  const owes = balanceCents > 0;
  return (
    <section
      aria-label="Cage-rental balance"
      className="mb-10 rounded-2xl border border-line bg-surface px-6 py-5 shadow-[var(--shadow-md)]"
    >
      <div className="flex items-center gap-2 text-fg-muted">
        <Wallet className="h-4 w-4" />
        <p className="text-[11px] uppercase tracking-[0.14em] text-fg-muted">
          You owe PFA for cage rentals
        </p>
      </div>
      <p className="tnum mt-4 text-4xl font-semibold tracking-tight text-fg">
        {formatCents(owes ? balanceCents : 0)}
      </p>
      <p className="mt-2 text-sm text-fg-muted">
        {owes
          ? `You owe PFA ${formatCents(balanceCents)} for cage rentals.`
          : "You're all paid up on cage rentals."}
      </p>
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-line pt-3 text-xs text-fg-subtle">
        <dt>Total cage rentals billed</dt>
        <dd className="tnum text-right text-fg-muted">
          {formatCents(owedCageCents)}
        </dd>
        <dt>Payments received by PFA</dt>
        <dd className="tnum text-right text-fg-muted">
          −{formatCents(paidCents)}
        </dd>
      </dl>
      <p className="mt-3 text-xs text-fg-subtle">
        Read-only — pay PFA directly. Program/work hours are paid to you by
        PFA separately and are not shown here.
      </p>
    </section>
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
      className="group relative flex items-start gap-3.5 rounded-xl border border-line bg-surface px-5 py-4 shadow-[var(--shadow-sm)] transition hover:-translate-y-0.5 hover:border-gold/40 hover:shadow-[var(--shadow-md)] focus-visible:outline-none focus-visible:border-gold/40 focus-visible:ring-2 focus-visible:ring-gold/40"
    >
      <span className="grid h-10 w-10 flex-none place-items-center rounded-[10px] border border-line bg-surface-2 text-fg-muted transition group-hover:border-gold/40 group-hover:bg-gold/10 group-hover:text-gold-strong">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between">
          <span className="text-sm font-semibold text-fg">{title}</span>
          <ArrowUpRight className="h-3.5 w-3.5 -translate-x-1 text-gold-strong opacity-0 transition group-hover:translate-x-0 group-hover:opacity-100" />
        </span>
        <span className="mt-0.5 block text-sm text-fg-muted">{body}</span>
      </span>
    </Link>
  );
}

function formatCents(cents: number): string {
  // Cents-precise ($1,234.50) for the balance card — a coach needs the
  // exact owed figure, not the whole-dollar rounding the stat heroes use.
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatHours(minutes: number): string {
  // 1.5h instead of "1 hr 30 min" — fits the big-numeric stat-tile aesthetic.
  const h = minutes / 60;
  return h % 1 === 0 ? `${h}` : h.toFixed(1);
}
