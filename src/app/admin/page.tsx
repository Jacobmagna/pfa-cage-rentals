import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  sql as drizzleSql,
} from "drizzle-orm";
import {
  CalendarDays,
  ChevronDown,
  ChevronUp,
  ClipboardList,
  Coins,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { db } from "@/db";
import {
  auditLog,
  blockedTimes,
  hourLogs,
  programs,
  programScheduleBlockCoaches,
  programScheduleBlocks,
  resources,
  sessionsBilling,
  users,
} from "@/db/schema";
import { requireRole } from "@/lib/authz";
import { totalFromSnapshot } from "@/lib/billing";
import { listActiveCoaches } from "@/lib/server/coaches";
import { formatDollars } from "@/lib/format-money";
import { formatRelative } from "@/lib/format-relative";
import {
  reconcileBlocks,
  type ReconBlock,
  type ReconCoach,
  type ReconLog,
} from "@/lib/server/reconciliation";
import {
  formatPfaTime12h,
  parsePfaInput,
  pfaDayEnd,
  pfaDayStart,
  pfaMonthEnd,
  pfaMonthStart,
} from "@/lib/timezone";
import { StatCard } from "@/app/_components/stat-card";
import {
  ActivityFeed,
  type ActivityFeedItem,
} from "@/app/admin/_components/activity-feed";
import { describeActivity } from "@/app/admin/_components/activity-feed.logic";
import {
  type MasterBlockedTime,
  type MasterProgramBlock,
  type MasterProgramRow,
  type MasterResourceRow,
  type MasterSession,
} from "@/app/admin/_components/master-schedule-grid";
import { EditableMasterSchedule } from "@/app/admin/_components/editable-master-schedule";
import { AutoRefresh } from "@/app/admin/schedule/_components/auto-refresh";
import { WeekNav } from "@/app/admin/schedule/_components/week-nav";

// /admin landing — the new Home tab (QA4-C1). Two surfaces:
//
//   1. Four StatCards anchored to `now` (NOT the selected day): money
//      owed/owing this month + session counts today. Money direction is
//      load-bearing — cage rentals are a RECEIVABLE (coaches OWE PFA) and
//      program hours are a PAYOUT (PFA PAYS coaches), so the two money
//      cards must never be swapped.
//
//   2. A read-only Master Schedule for a selectable day (?date=YYYY-MM-DD,
//      default today). Reuses the shared MasterScheduleGrid + WeekNav +
//      AutoRefresh; program-block colors come from the same pure
//      reconcileBlocks engine the Programs schedule page feeds.
//
// The cage dashboard that used to live here moved to /admin/cage-rentals.

type SearchParams = Promise<{ date?: string; schedule?: string }>;

// Build a clean `/admin?...` href, dropping undefined/empty values so the
// toggle links stay tidy (e.g. `/admin` when nothing is set).
function buildAdminHref(query: Record<string, string | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v) parts.push(`${k}=${v}`);
  }
  return parts.length ? `/admin?${parts.join("&")}` : "/admin";
}

export default async function AdminHome({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requireRole("admin");

  const params = await searchParams;
  const selectedDate = parseDateInput(params.date) ?? startOfToday();
  const scheduleOpen = params.schedule === "open";

  // Toggle-bar href: closed → add schedule=open; open → drop it. Both
  // preserve the current ?date so navigating in/out keeps the selected day.
  const toggleHref = scheduleOpen
    ? buildAdminHref({ date: params.date })
    : buildAdminHref({ date: params.date, schedule: "open" });

  // Card windows are anchored to NOW, never the selected day.
  const now = new Date();
  const dayStartNow = pfaDayStart(now);
  const dayEndNow = pfaDayEnd(now);
  const monthStart = pfaMonthStart(now);
  const monthEndExclusive = pfaMonthEnd(now);

  // Master Schedule windows follow the SELECTED day.
  const schedDayStart = pfaDayStart(selectedDate);
  const schedDayEnd = pfaDayEnd(selectedDate);

  const [
    cageMonthRows,
    programMonthRows,
    [{ count: cageSessionsToday }],
    [{ count: programSessionsToday }],
    resourceRows,
    sessionRows,
    blockRows,
    programRows,
    programBlockRows,
    logRows,
    coachAuditRows,
    coachAccountRows,
    activeCoaches,
  ] = await Promise.all([
    // Cage rentals this month → coaches OWE PFA (receivable).
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
    // Program hours this month → PFA PAYS coaches (payout).
    db
      .select({
        startAt: hourLogs.startAt,
        endAt: hourLogs.endAt,
        ratePer30MinCents: hourLogs.ratePer30MinCents,
      })
      .from(hourLogs)
      .where(
        and(
          gte(hourLogs.startAt, monthStart),
          lt(hourLogs.startAt, monthEndExclusive),
        ),
      ),
    db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(sessionsBilling)
      .where(
        and(
          gte(sessionsBilling.startAt, dayStartNow),
          lt(sessionsBilling.startAt, dayEndNow),
        ),
      ),
    db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(programScheduleBlocks)
      .where(
        and(
          gte(programScheduleBlocks.startAt, dayStartNow),
          lt(programScheduleBlocks.startAt, dayEndNow),
        ),
      ),
    // Master Schedule data for the SELECTED day.
    db
      .select({
        id: resources.id,
        name: resources.name,
        type: resources.type,
        sortOrder: resources.sortOrder,
      })
      .from(resources)
      .where(eq(resources.active, true))
      .orderBy(asc(resources.sortOrder)),
    db
      .select({
        id: sessionsBilling.id,
        resourceId: sessionsBilling.resourceId,
        coachName: users.name,
        coachEmail: users.email,
        startAt: sessionsBilling.startAt,
        endAt: sessionsBilling.endAt,
        useType: sessionsBilling.useType,
        isTeamRental: sessionsBilling.isTeamRental,
      })
      .from(sessionsBilling)
      .innerJoin(users, eq(sessionsBilling.coachId, users.id))
      .where(
        and(
          gte(sessionsBilling.startAt, schedDayStart),
          lt(sessionsBilling.startAt, schedDayEnd),
        ),
      )
      .orderBy(asc(sessionsBilling.startAt)),
    db
      .select({
        id: blockedTimes.id,
        resourceId: blockedTimes.resourceId,
        startAt: blockedTimes.startAt,
        endAt: blockedTimes.endAt,
        reason: blockedTimes.reason,
      })
      .from(blockedTimes)
      .where(
        and(
          gte(blockedTimes.startAt, schedDayStart),
          lt(blockedTimes.startAt, schedDayEnd),
        ),
      ),
    db
      .select({ id: programs.id, name: programs.name })
      .from(programs)
      .where(eq(programs.active, true))
      .orderBy(asc(programs.name)),
    db
      .select({
        id: programScheduleBlocks.id,
        programId: programScheduleBlocks.programId,
        scheduledCoachId: programScheduleBlocks.scheduledCoachId,
        coachName: users.name,
        coachEmail: users.email,
        startAt: programScheduleBlocks.startAt,
        endAt: programScheduleBlocks.endAt,
        seriesId: programScheduleBlocks.seriesId,
      })
      .from(programScheduleBlocks)
      .innerJoin(users, eq(programScheduleBlocks.scheduledCoachId, users.id))
      .where(
        and(
          gte(programScheduleBlocks.startAt, schedDayStart),
          lt(programScheduleBlocks.startAt, schedDayEnd),
        ),
      )
      .orderBy(asc(programScheduleBlocks.startAt)),
    // Hour-logs overlapping the selected day, for reconciliation
    // (same shape the Programs schedule page feeds reconcileBlocks).
    db
      .select({
        coachId: hourLogs.coachId,
        coachName: users.name,
        coachEmail: users.email,
        programId: hourLogs.programId,
        startAt: hourLogs.startAt,
        endAt: hourLogs.endAt,
      })
      .from(hourLogs)
      .innerJoin(users, eq(hourLogs.coachId, users.id))
      .where(
        and(lt(hourLogs.startAt, schedDayEnd), gt(hourLogs.endAt, schedDayStart)),
      ),
    // Recent activity feed (QA6-2): the latest things COACHES have done.
    // Join the audit log to its actor and keep only coach actors so admin
    // actions never leak into the feed. Over-fetch (12) so the merge+filter
    // below can still produce ~10 interesting rows.
    db
      .select({
        id: auditLog.id,
        name: users.name,
        email: users.email,
        entityType: auditLog.entityType,
        action: auditLog.action,
        ts: auditLog.ts,
      })
      .from(auditLog)
      .innerJoin(users, eq(auditLog.actorUserId, users.id))
      .where(eq(users.role, "coach"))
      .orderBy(desc(auditLog.ts))
      .limit(12),
    // New coach accounts → highlighted "Joined" rows (a security signal).
    db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(and(eq(users.role, "coach"), isNull(users.deletedAt)))
      .orderBy(desc(users.createdAt))
      .limit(12),
    // QA10 W3.6: active coaches for the click-to-add dialogs (cage + program).
    // Same canonical list both dialogs' coach pickers use on the standalone
    // pages; the {id,name,email} shape satisfies both dialog prop types.
    listActiveCoaches(),
  ]);

  // Money totals read each row's snapshotted rate directly — never
  // recompute from current overrides.
  let cageOwedMonthCents = 0;
  for (const s of cageMonthRows) {
    cageOwedMonthCents += totalFromSnapshot(
      s.startAt,
      s.endAt,
      s.ratePer30MinCents,
    );
  }
  let programPayMonthCents = 0;
  for (const l of programMonthRows) {
    programPayMonthCents += totalFromSnapshot(
      l.startAt,
      l.endAt,
      l.ratePer30MinCents ?? 0,
    );
  }

  // Shape the Master Schedule rows for the read-only grid.
  const masterResources: MasterResourceRow[] = resourceRows.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
  }));
  const masterSessions: MasterSession[] = sessionRows.map((s) => ({
    id: s.id,
    resourceId: s.resourceId,
    coachName: s.coachName ?? s.coachEmail,
    startAt: s.startAt,
    endAt: s.endAt,
    useType: s.useType,
    isTeamRental: s.isTeamRental,
  }));
  const masterBlocked: MasterBlockedTime[] = blockRows.map((b) => ({
    id: b.id,
    resourceId: b.resourceId,
    startAt: b.startAt,
    endAt: b.endAt,
    reason: b.reason,
  }));
  const masterPrograms: MasterProgramRow[] = programRows.map((p) => ({
    id: p.id,
    name: p.name,
  }));

  // QA10 W3.6: dialog option lists for the editable Home grid. Shapes MIRROR
  // the standalone pages exactly:
  //   - cage dialog (ScheduleCreateDialog): sessions-client CoachOption +
  //     ResourceOption (resources carry sortOrder).
  //   - program dialog (ProgramBlockDialog): ProgramOption {id,name}, its own
  //     CoachOption {id,name,email}, W3.3 ResourceOption {id,name,type}.
  // activeCoaches' {id,name,email} satisfies both dialogs' coach prop types.
  const cageResourceOptions = resourceRows.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    sortOrder: r.sortOrder,
  }));
  const programResourceOptions = resourceRows.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
  }));

  // QA10 W3.2: the full scheduled-coach set for the day's program blocks,
  // grouped by block (name = users.name ?? users.email, primary first).
  const programBlockIds = programBlockRows.map((b) => b.id);
  const programBlockCoachRows =
    programBlockIds.length > 0
      ? await db
          .select({
            blockId: programScheduleBlockCoaches.blockId,
            coachId: programScheduleBlockCoaches.coachId,
            coachName: users.name,
            coachEmail: users.email,
          })
          .from(programScheduleBlockCoaches)
          .innerJoin(users, eq(programScheduleBlockCoaches.coachId, users.id))
          .where(inArray(programScheduleBlockCoaches.blockId, programBlockIds))
      : [];
  const programCoachesByBlock = new Map<string, ReconCoach[]>();
  for (const r of programBlockCoachRows) {
    const list = programCoachesByBlock.get(r.blockId) ?? [];
    list.push({ coachId: r.coachId, coachName: r.coachName ?? r.coachEmail });
    programCoachesByBlock.set(r.blockId, list);
  }
  const coachesForBlock = (
    b: (typeof programBlockRows)[number],
  ): ReconCoach[] => {
    const primary = {
      coachId: b.scheduledCoachId,
      coachName: b.coachName ?? b.coachEmail,
    };
    const list = programCoachesByBlock.get(b.id);
    if (!list || list.length === 0) return [primary];
    return [primary, ...list.filter((c) => c.coachId !== b.scheduledCoachId)];
  };

  // Reconcile the day's scheduled program blocks against coach hour-logs
  // (FEAT-16). The engine is pure — inject `now` + the PFA time formatter.
  const reconBlocks: ReconBlock[] = programBlockRows.map((b) => ({
    id: b.id,
    programId: b.programId,
    scheduledCoachId: b.scheduledCoachId,
    scheduledCoachName: b.coachName ?? b.coachEmail,
    coaches: coachesForBlock(b),
    startAt: b.startAt,
    endAt: b.endAt,
  }));
  const reconLogs: ReconLog[] = logRows.map((l) => ({
    coachId: l.coachId,
    coachName: l.coachName ?? l.coachEmail,
    programId: l.programId,
    startAt: l.startAt,
    endAt: l.endAt,
  }));
  const reconciliation = reconcileBlocks(
    { blocks: reconBlocks, logs: reconLogs, now: new Date() },
    formatPfaTime12h,
  );

  const masterProgramBlocks: MasterProgramBlock[] = programBlockRows.map(
    (b) => ({
      id: b.id,
      programId: b.programId,
      coachName: b.coachName ?? b.coachEmail,
      startAt: b.startAt,
      endAt: b.endAt,
      status: reconciliation[b.id]?.status,
    }),
  );

  // Build the Recent activity feed: map coach audit events through the pure
  // describeActivity mapper (skipping uninteresting entities) and coach
  // signups into "Joined" rows, merge, sort newest-first, take the top 10,
  // then attach a relative "time ago" string anchored to `now`.
  const feedNow = new Date();
  type FeedSeed = ActivityFeedItem & { ts: Date };
  const feedSeeds: FeedSeed[] = [];
  for (const row of coachAuditRows) {
    const described = describeActivity(row.entityType, row.action);
    if (!described) continue;
    feedSeeds.push({
      id: `audit:${row.id}`,
      coachName: row.name ?? row.email,
      kind: described.kind,
      label: described.label,
      timeAgo: "",
      ts: row.ts,
    });
  }
  for (const row of coachAccountRows) {
    feedSeeds.push({
      id: `joined:${row.id}`,
      coachName: row.name ?? row.email,
      kind: "joined",
      label: "Joined",
      timeAgo: "",
      ts: row.createdAt,
    });
  }
  feedSeeds.sort((a, b) => b.ts.getTime() - a.ts.getTime());
  const activityItems: ActivityFeedItem[] = feedSeeds.slice(0, 10).map((s) => ({
    id: s.id,
    coachName: s.coachName,
    kind: s.kind,
    label: s.label,
    timeAgo: formatRelative(s.ts, feedNow),
  }));

  return (
    <>
      <header className="mb-10">
        <p className="text-[11.5px] font-semibold uppercase tracking-[0.14em] text-fg-muted">
          Admin
        </p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">Home</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Today at a glance across cage rentals and programs.
        </p>
      </header>

      <section className="mb-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={<Coins className="h-4 w-4" />}
          label="Coaches owe PFA"
          value={formatDollars(cageOwedMonthCents)}
          sub="Cage rentals this month"
          accent
        />
        <StatCard
          icon={<Wallet className="h-4 w-4" />}
          label="PFA owes coaches"
          value={formatDollars(programPayMonthCents)}
          sub="Program pay this month"
        />
        <StatCard
          icon={<CalendarDays className="h-4 w-4" />}
          label="Cage sessions today"
          value={String(cageSessionsToday)}
          sub={cageSessionsToday > 0 ? "Booked" : "Quiet day so far"}
        />
        <StatCard
          icon={<ClipboardList className="h-4 w-4" />}
          label="Program sessions today"
          value={String(programSessionsToday)}
          sub={programSessionsToday > 0 ? "Scheduled" : "Nothing scheduled"}
        />
      </section>

      <ActivityFeed items={activityItems} />

      <section aria-labelledby="master-schedule-heading">
        <h2 id="master-schedule-heading" className="sr-only">
          Master Schedule
        </h2>

        <Link
          href={toggleHref}
          aria-expanded={scheduleOpen}
          className="flex w-full items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3 text-left shadow-[var(--shadow-sm)] transition hover:-translate-y-px hover:border-gold/40 hover:shadow-[var(--shadow-md)]"
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-md border border-line bg-bg text-fg-muted">
            <CalendarDays className="h-4 w-4" />
          </span>
          <span className="flex-1">
            <span className="block text-sm font-semibold">Master Schedule</span>
            <span className="block text-xs text-fg-muted">
              {scheduleOpen
                ? "Browsing cage + program sessions by day"
                : "Show cage + program sessions for a day"}
            </span>
          </span>
          <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-[0.12em] text-fg-muted">
            {scheduleOpen ? "Hide" : "Show"}
            {scheduleOpen ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
          </span>
        </Link>

        {scheduleOpen ? (
          <div className="mt-5">
            <WeekNav
              selectedDate={selectedDate}
              extraParams={{ schedule: "open" }}
              preserveScroll
            />

            <AutoRefresh />

            <EditableMasterSchedule
              resources={masterResources}
              sessions={masterSessions}
              blockedTimes={masterBlocked}
              programs={masterPrograms}
              programBlocks={masterProgramBlocks}
              selectedDate={selectedDate}
              cageCoaches={activeCoaches}
              cageResources={cageResourceOptions}
              programOptions={masterPrograms}
              programCoaches={activeCoaches}
              programResources={programResourceOptions}
            />
          </div>
        ) : null}
      </section>
    </>
  );
}

function parseDateInput(s: string | undefined): Date | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return parsePfaInput(s, "00:00");
}

function startOfToday(): Date {
  return pfaDayStart(new Date());
}
