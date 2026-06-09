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
  programScheduleSeries,
  programScheduleSeriesCoaches,
  resources,
  sessionsBilling,
  users,
} from "@/db/schema";
import { requireRole } from "@/lib/authz";
import { totalFromSnapshot } from "@/lib/billing";
import { findOverlappingLogIds } from "@/lib/hour-log-overlap";
import { fetchHourLogRowsWithScheduleNotes } from "@/lib/reports/hour-log-fetch";
import type { NormalizedHourLogFilters } from "@/lib/reports/hour-log-filters";
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
  NeedsReviewCard,
  type NeedsReviewItem,
} from "@/app/admin/_components/needs-review-card";
import { fetchBlockAccountabilityAlerts } from "@/lib/server/needs-review";
import {
  type MasterBlockedTime,
  type MasterProgramBlock,
  type MasterProgramRow,
  type MasterResourceRow,
  type MasterSession,
} from "@/app/admin/_components/master-schedule-grid";
import { EditableMasterSchedule } from "@/app/admin/_components/editable-master-schedule";
import type { SessionFormInitialValues } from "@/app/admin/sessions/_components/session-form-dialog";
import type { BlockEditInitialValues } from "@/app/admin/schedule/_components/block-edit-dialog";
import type {
  ProgramBlockEditInitial,
  SeriesView,
} from "@/app/admin/hour-log/schedule/_components/program-block-dialog";
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
  // Master Schedule is the hero at the top of Home, so it defaults to
  // EXPANDED. It collapses only when explicitly closed via ?schedule=closed.
  const scheduleOpen = params.schedule !== "closed";

  // Toggle-bar href: open → add schedule=closed; closed → drop it. Both
  // preserve the current ?date so navigating in/out keeps the selected day.
  const toggleHref = scheduleOpen
    ? buildAdminHref({ date: params.date, schedule: "closed" })
    : buildAdminHref({ date: params.date });

  // Card windows are anchored to NOW, never the selected day.
  const now = new Date();
  const dayStartNow = pfaDayStart(now);
  const dayEndNow = pfaDayEnd(now);
  const monthStart = pfaMonthStart(now);
  const monthEndExclusive = pfaMonthEnd(now);

  // Master Schedule windows follow the SELECTED day.
  const schedDayStart = pfaDayStart(selectedDate);
  const schedDayEnd = pfaDayEnd(selectedDate);

  // QA10 W3-polish13b: wide-window filter for the "Unscheduled hours — needs
  // review" attention card. We want the FULL backlog of still-unreviewed
  // unscheduled logs, not just this month, so nothing stale is missed. Floor
  // at a fixed date that predates the app through today's PFA end, with NO
  // coach/program narrowing. Reuses the SAME `fetchHourLogRowsWithScheduleNotes`
  // the Hour Log table uses so the `unscheduled` flag matches exactly.
  //
  // Known small-data simplification: this loads every program hour-log + every
  // scheduled block on each dashboard render. Fine at current scale; revisit
  // (e.g. push the unscheduled+unreviewed filter into SQL) if data grows.
  const reviewFloor = pfaDayStart(new Date("2024-01-01T12:00:00Z"));
  const reviewCeiling = pfaDayEnd(now);
  const reviewFilter: NormalizedHourLogFilters = {
    from: "2024-01-01",
    to: "2024-01-01",
    fromDate: reviewFloor,
    toDateExclusive: reviewCeiling,
    coachId: undefined,
    programId: undefined,
    isFiltered: true,
  };

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
    reviewWindowRows,
    blockAlerts,
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
        coachId: sessionsBilling.coachId,
        coachName: users.name,
        coachEmail: users.email,
        startAt: sessionsBilling.startAt,
        endAt: sessionsBilling.endAt,
        note: sessionsBilling.note,
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
        note: programScheduleBlocks.note,
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
    // QA10 W3-polish13b: full-backlog rows for the unscheduled-hours card.
    fetchHourLogRowsWithScheduleNotes(reviewFilter),
    // QA10 W3-polish15b-ii: block-accountability alerts (cancelled + no-show)
    // for the unified Needs-review card.
    fetchBlockAccountabilityAlerts(now),
  ]);

  // QA10 W3-polish16: bucket each UNREVIEWED review-window row into exactly one
  // hour-log alert type, by priority, so no log shows under two tags:
  //   • unscheduled — logged program hours with no matching block (as before)
  //   • double_logged — a non-unscheduled log overlapping ANOTHER log of the
  //     same coach (double-pay / duplicate-entry risk)
  //   • wrong_time — a non-unscheduled, non-overlapping log that reconciliation
  //     flagged with a scheduleNote (overlaps a block but mismatches it)
  const reviewable = reviewWindowRows.filter((r) => !r.reviewedAt);
  const unscheduledRows = reviewable.filter((r) => r.unscheduled);
  const rest = reviewable.filter((r) => !r.unscheduled);
  const doubleIds = findOverlappingLogIds(
    reviewable.map((r) => ({
      id: r.id,
      coachId: r.coachId,
      startMs: r.startAt.getTime(),
      endMs: r.endAt.getTime(),
    })),
  );
  const doubleRows = rest.filter((r) => doubleIds.has(r.id));
  const wrongTimeRows = rest.filter(
    (r) => !doubleIds.has(r.id) && r.scheduleNote,
  );

  // QA10 W3-polish15b-ii / polish16: merge the hour-log alerts with the
  // block-accountability alerts (cancelled + no-show) into one Needs-review
  // queue, newest-first.
  const mergedReview: NeedsReviewItem[] = [
    ...unscheduledRows.map((r) => ({
      type: "unscheduled" as const,
      id: r.id,
      coachName: r.coachName,
      programName: r.programName,
      startAt: r.startAt,
      endAt: r.endAt,
    })),
    ...doubleRows.map((r) => ({
      type: "double_logged" as const,
      id: r.id,
      coachName: r.coachName,
      programName: r.programName,
      startAt: r.startAt,
      endAt: r.endAt,
    })),
    ...wrongTimeRows.map((r) => ({
      type: "wrong_time" as const,
      id: r.id,
      coachName: r.coachName,
      programName: r.programName,
      startAt: r.startAt,
      endAt: r.endAt,
      detail: r.scheduleNote,
    })),
    ...blockAlerts.cancelled,
    ...blockAlerts.noShow,
  ].sort((a, b) => b.startAt.getTime() - a.startAt.getTime());

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

  // QA10 W3.9: SessionFormInitialValues for each visible cage session, keyed
  // by id. Feeds SessionFormDialog (mode="edit") when a session bar is clicked
  // on the Home Master Schedule. Shape mirrors the standalone schedule's edit.
  const sessionEditById: Record<string, SessionFormInitialValues> =
    Object.fromEntries(
      sessionRows.map((s) => [
        s.id,
        {
          id: s.id,
          coachId: s.coachId,
          resourceId: s.resourceId,
          startAt: s.startAt,
          endAt: s.endAt,
          note: s.note,
        },
      ]),
    );

  // QA10 W3.9: BlockEditInitialValues for each visible blocked-time, keyed by
  // id. Feeds BlockEditDialog when a blocked-time bar is clicked. The master
  // blocked rows already carry everything the dialog needs.
  const blockEditById: Record<string, BlockEditInitialValues> =
    Object.fromEntries(
      blockRows.map((b) => [
        b.id,
        {
          id: b.id,
          resourceId: b.resourceId,
          startAt: b.startAt,
          endAt: b.endAt,
          reason: b.reason,
        },
      ]),
    );

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

  // QA10 W3.9: occupied-resource ids per visible block, from its LINKED
  // blocked_times (program_schedule_block_id), so the edit dialog can prefill
  // the occupancy checkboxes. Mirrors /admin/hour-log/schedule/page.tsx.
  const blockOccupancyRows =
    programBlockIds.length > 0
      ? await db
          .select({
            programScheduleBlockId: blockedTimes.programScheduleBlockId,
            resourceId: blockedTimes.resourceId,
          })
          .from(blockedTimes)
          .where(
            inArray(blockedTimes.programScheduleBlockId, programBlockIds),
          )
      : [];
  const resourceIdsByBlock = new Map<string, string[]>();
  for (const r of blockOccupancyRows) {
    if (!r.programScheduleBlockId) continue;
    const list = resourceIdsByBlock.get(r.programScheduleBlockId) ?? [];
    if (!list.includes(r.resourceId)) list.push(r.resourceId);
    resourceIdsByBlock.set(r.programScheduleBlockId, list);
  }

  // QA10 W3.9: for any block that is a series occurrence, fetch its parent
  // series + coach set + occupied resources so ProgramBlockDialog can show the
  // recurrence summary and prefill the "Edit series" form. Query only the
  // distinct non-null seriesIds present today. Mirrors the program-schedule
  // page's seriesById build.
  const seriesIds = [
    ...new Set(
      programBlockRows
        .map((b) => b.seriesId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const seriesRows =
    seriesIds.length > 0
      ? await db
          .select({
            id: programScheduleSeries.id,
            programId: programScheduleSeries.programId,
            scheduledCoachId: programScheduleSeries.scheduledCoachId,
            daysOfWeek: programScheduleSeries.daysOfWeek,
            startTime: programScheduleSeries.startTime,
            endTime: programScheduleSeries.endTime,
            startsOn: programScheduleSeries.startsOn,
            endsOn: programScheduleSeries.endsOn,
            frequency: programScheduleSeries.frequency,
            interval: programScheduleSeries.interval,
            note: programScheduleSeries.note,
          })
          .from(programScheduleSeries)
          .where(inArray(programScheduleSeries.id, seriesIds))
      : [];
  const seriesCoachRows =
    seriesIds.length > 0
      ? await db
          .select({
            seriesId: programScheduleSeriesCoaches.seriesId,
            coachId: programScheduleSeriesCoaches.coachId,
          })
          .from(programScheduleSeriesCoaches)
          .where(inArray(programScheduleSeriesCoaches.seriesId, seriesIds))
      : [];
  const seriesCoachIdsBySeries = new Map<string, string[]>();
  for (const r of seriesCoachRows) {
    const list = seriesCoachIdsBySeries.get(r.seriesId) ?? [];
    list.push(r.coachId);
    seriesCoachIdsBySeries.set(r.seriesId, list);
  }
  // Each series' occupied-resource set from ITS OCCURRENCE BLOCKS' linked
  // blocked_times (no separate series-resources table).
  const seriesResourceRows =
    seriesIds.length > 0
      ? await db
          .selectDistinct({
            seriesId: programScheduleBlocks.seriesId,
            resourceId: blockedTimes.resourceId,
          })
          .from(blockedTimes)
          .innerJoin(
            programScheduleBlocks,
            eq(blockedTimes.programScheduleBlockId, programScheduleBlocks.id),
          )
          .where(inArray(programScheduleBlocks.seriesId, seriesIds))
      : [];
  const resourceIdsBySeries = new Map<string, string[]>();
  for (const r of seriesResourceRows) {
    if (!r.seriesId) continue;
    const list = resourceIdsBySeries.get(r.seriesId) ?? [];
    if (!list.includes(r.resourceId)) list.push(r.resourceId);
    resourceIdsBySeries.set(r.seriesId, list);
  }
  const seriesById: Record<string, SeriesView> = Object.fromEntries(
    seriesRows.map((s) => {
      const extra = (seriesCoachIdsBySeries.get(s.id) ?? []).filter(
        (id) => id !== s.scheduledCoachId,
      );
      return [
        s.id,
        {
          ...s,
          scheduledCoachIds: [s.scheduledCoachId, ...extra],
          resourceIds: resourceIdsBySeries.get(s.id) ?? [],
        },
      ];
    }),
  );

  // QA10 W3.9: ProgramBlockEditInitial for each visible block, keyed by id.
  // Feeds ProgramBlockDialog (mode="edit"). scheduledCoachIds is primary-first
  // (reuses coachesForBlock); resourceIds from the occupancy map above.
  const programEditById: Record<string, ProgramBlockEditInitial> =
    Object.fromEntries(
      programBlockRows.map((b) => [
        b.id,
        {
          id: b.id,
          programId: b.programId,
          scheduledCoachId: b.scheduledCoachId,
          scheduledCoachIds: coachesForBlock(b).map((c) => c.coachId),
          startAt: b.startAt,
          endAt: b.endAt,
          note: b.note,
          seriesId: b.seriesId,
          resourceIds: resourceIdsByBlock.get(b.id) ?? [],
        },
      ]),
    );

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

      <section aria-labelledby="master-schedule-heading" className="mb-10">
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
              sessionEditById={sessionEditById}
              blockEditById={blockEditById}
              programEditById={programEditById}
              seriesById={seriesById}
              reconciliation={reconciliation}
            />
          </div>
        ) : null}
      </section>

      <section className="mb-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={<Coins className="h-4 w-4" />}
          label="Coaches owe PFA"
          value={formatDollars(cageOwedMonthCents)}
          sub="Rentals this month"
          accent
        />
        <StatCard
          icon={<Wallet className="h-4 w-4" />}
          label="PFA owes coaches"
          value={formatDollars(programPayMonthCents)}
          sub="Work pay this month"
        />
        <StatCard
          icon={<CalendarDays className="h-4 w-4" />}
          label="Rentals today"
          value={String(cageSessionsToday)}
          sub={cageSessionsToday > 0 ? "Booked" : "Quiet day so far"}
        />
        <StatCard
          icon={<ClipboardList className="h-4 w-4" />}
          label="Work scheduled today"
          value={String(programSessionsToday)}
          sub={programSessionsToday > 0 ? "Scheduled" : "Nothing scheduled"}
        />
      </section>

      {mergedReview.length > 0 ? (
        <NeedsReviewCard
          items={mergedReview.slice(0, 5)}
          totalCount={mergedReview.length}
        />
      ) : null}

      <ActivityFeed items={activityItems} />
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
