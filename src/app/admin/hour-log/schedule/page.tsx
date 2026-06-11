import Link from "next/link";
import { and, asc, eq, gt, gte, inArray, lt } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import { db } from "@/db";
import {
  blockedTimes,
  hourLogs,
  programs,
  programScheduleBlockCoaches,
  programScheduleBlocks,
  programScheduleSeries,
  programScheduleSeriesCoaches,
  resources,
  users,
} from "@/db/schema";
import { requireRole } from "@/lib/authz";
import { listActiveCoaches } from "@/lib/server/coaches";
import {
  reconcileBlocks,
  type ReconBlock,
  type ReconCoach,
  type ReconLog,
} from "@/lib/server/reconciliation";
import {
  formatPfaDateLong,
  formatPfaTime12h,
  parsePfaInput,
  pfaDayEnd,
  pfaDayStart,
} from "@/lib/timezone";
import { AutoRefresh } from "@/app/admin/schedule/_components/auto-refresh";
import { WeekNav } from "@/app/admin/schedule/_components/week-nav";
import { ProgramScheduleGrid } from "./_components/program-schedule-grid";

// Programs schedule grid page (SCR-1a). Mirrors the cage schedule
// (/admin/schedule) but rows = programs and each cell authors an
// admin-intended program block (program + scheduled coach + time) that
// FEAT-16 later reconciles against coach hour-logs.
//
// Click an empty cell → create dialog pre-seeded with that program +
// the cell's start time. Click a block bar → edit/delete dialog. No
// drag — the admin sets precise start/end in the dialog.
//
// URL state: ?date=YYYY-MM-DD (defaults to today).

type SearchParams = Promise<{ date?: string }>;

export default async function ProgramsSchedulePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requireRole("admin");
  const params = await searchParams;
  const selectedDate = parseDateInput(params.date) ?? startOfToday();

  const dayStart = pfaDayStart(selectedDate);
  const dayEnd = pfaDayEnd(selectedDate);

  const [activePrograms, blockRows, coachRows, logRows, resourceRows] =
    await Promise.all([
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
      // QA-R2 #10: LEFT join so coachless (Unassigned) blocks still appear.
      .leftJoin(users, eq(programScheduleBlocks.scheduledCoachId, users.id))
      .where(
        and(
          gte(programScheduleBlocks.startAt, dayStart),
          lt(programScheduleBlocks.startAt, dayEnd),
        ),
      )
      .orderBy(asc(programScheduleBlocks.startAt)),
    listActiveCoaches(),
    // Hour-logs that overlap the selected day, for reconciliation
    // (FEAT-16). Overlap = log starts before the day ends AND ends after
    // the day starts.
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
        and(
          // 1b security B: held logs stay off the reconciliation overlay.
          eq(hourLogs.status, "posted"),
          lt(hourLogs.startAt, dayEnd),
          gt(hourLogs.endAt, dayStart),
        ),
      ),
    // QA10 W3.3: active cage resources, ordered, for the occupancy picker.
    db
      .select({
        id: resources.id,
        name: resources.name,
        type: resources.type,
      })
      .from(resources)
      .where(eq(resources.active, true))
      .orderBy(asc(resources.sortOrder)),
  ]);

  // QA10 W3.2: the FULL scheduled-coach set for this day's blocks, grouped
  // by block. Query once for all visible block ids, then group → coaches[]
  // (name = users.name ?? users.email). Primary stays scheduledCoachId/Name.
  const blockIds = blockRows.map((b) => b.id);
  const blockCoachRows =
    blockIds.length > 0
      ? await db
          .select({
            blockId: programScheduleBlockCoaches.blockId,
            coachId: programScheduleBlockCoaches.coachId,
            coachName: users.name,
            coachEmail: users.email,
          })
          .from(programScheduleBlockCoaches)
          .innerJoin(users, eq(programScheduleBlockCoaches.coachId, users.id))
          .where(inArray(programScheduleBlockCoaches.blockId, blockIds))
      : [];
  const coachesByBlock = new Map<string, ReconCoach[]>();
  for (const r of blockCoachRows) {
    const list = coachesByBlock.get(r.blockId) ?? [];
    list.push({ coachId: r.coachId, coachName: r.coachName ?? r.coachEmail });
    coachesByBlock.set(r.blockId, list);
  }

  // QA10 W3.3: the occupied-resource ids for each visible block, derived from
  // its LINKED blocked_times (program_schedule_block_id). Group by block id so
  // the edit dialog can prefill the occupancy checkboxes.
  const blockOccupancyRows =
    blockIds.length > 0
      ? await db
          .select({
            programScheduleBlockId: blockedTimes.programScheduleBlockId,
            resourceId: blockedTimes.resourceId,
          })
          .from(blockedTimes)
          .where(inArray(blockedTimes.programScheduleBlockId, blockIds))
      : [];
  const resourceIdsByBlock = new Map<string, string[]>();
  for (const r of blockOccupancyRows) {
    if (!r.programScheduleBlockId) continue;
    const list = resourceIdsByBlock.get(r.programScheduleBlockId) ?? [];
    if (!list.includes(r.resourceId)) list.push(r.resourceId);
    resourceIdsByBlock.set(r.programScheduleBlockId, list);
  }
  // Put the primary first within each block's coach list.
  // QA-R2 #10: a coachless block (null primary + no join rows) has no
  // scheduled coaches → empty set (no recon/no-show rows derive from it).
  const coachesFor = (b: (typeof blockRows)[number]): ReconCoach[] => {
    const list = coachesByBlock.get(b.id);
    if (b.scheduledCoachId === null) {
      return list ? [...list] : [];
    }
    const primary = {
      coachId: b.scheduledCoachId,
      coachName: b.coachName ?? b.coachEmail ?? "Unassigned",
    };
    if (!list || list.length === 0) return [primary];
    return [
      primary,
      ...list.filter((c) => c.coachId !== b.scheduledCoachId),
    ];
  };

  const blocks = blockRows.map((b) => ({
    id: b.id,
    programId: b.programId,
    scheduledCoachId: b.scheduledCoachId,
    // QA-R2 #10: coachless block → "Unassigned".
    coachName: b.coachName ?? b.coachEmail ?? "Unassigned",
    coaches: coachesFor(b).map((c) => ({ id: c.coachId, name: c.coachName })),
    startAt: b.startAt,
    endAt: b.endAt,
    note: b.note,
    seriesId: b.seriesId,
    // QA10 W3.3: occupied-resource ids for edit prefill.
    resourceIds: resourceIdsByBlock.get(b.id) ?? [],
  }));

  // RECUR-b2: for any block that is a series occurrence, fetch its parent
  // series so the dialog can show the recurrence summary + prefill the
  // "Edit series" form. Query only the distinct non-null seriesIds present
  // on this day; skip the query entirely when there are none.
  const seriesIds = [
    ...new Set(
      blocks
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
            // QA10 W3.1b: recurrence pattern, so the edit-series form opens
            // on the series' current frequency/interval.
            frequency: programScheduleSeries.frequency,
            interval: programScheduleSeries.interval,
            note: programScheduleSeries.note,
          })
          .from(programScheduleSeries)
          .where(inArray(programScheduleSeries.id, seriesIds))
      : [];

  // QA10 W3.2: the full scheduled-coach set per series, so the edit-series
  // form prefills every coach (primary first). Group by seriesId.
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

  // QA10 W3.3: derive each series' occupied-resource set from ITS OCCURRENCE
  // BLOCKS' linked blocked_times (no separate series-resources table). Pull
  // every block id belonging to these series (including blocks not visible
  // today), then the distinct resource ids among their linked blocked_times,
  // joined through blocked_times.program_schedule_block_id → blocks.seriesId.
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

  const seriesById = Object.fromEntries(
    seriesRows.map((s) => {
      const extra = (seriesCoachIdsBySeries.get(s.id) ?? []).filter(
        (id) => id !== s.scheduledCoachId,
      );
      return [
        s.id,
        {
          ...s,
          // QA-R2 #10: a coachless series has an EMPTY coach set.
          scheduledCoachIds:
            s.scheduledCoachId === null
              ? extra
              : [s.scheduledCoachId, ...extra],
          resourceIds: resourceIdsBySeries.get(s.id) ?? [],
        },
      ];
    }),
  );

  // Reconcile the day's scheduled blocks against the coach hour-logs
  // (FEAT-16). The engine is pure — we inject `now` + the PFA time
  // formatter here.
  const reconBlocks: ReconBlock[] = blocks.map((b) => ({
    id: b.id,
    programId: b.programId,
    scheduledCoachId: b.scheduledCoachId,
    scheduledCoachName: b.coachName,
    coaches: b.coaches.map((c) => ({ coachId: c.id, coachName: c.name })),
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

  const dateLabel = formatPfaDateLong(selectedDate);
  const blockCount = blocks.length;

  return (
    <>
      <Link
        href="/admin/hour-log"
        className="inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg mb-6 transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to Work Log
      </Link>

      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1.5">
          <p className="text-[11.5px] font-semibold uppercase tracking-[0.14em] text-fg-muted">
            Schedule
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">{dateLabel}</h1>
          <p className="text-sm text-fg-muted">
            {blockCount} {blockCount === 1 ? "block" : "blocks"}
          </p>
          <p className="text-xs italic text-fg-subtle md:hidden">
            This page is designed for desktop. Rotate your device or use a
            laptop for the full experience.
          </p>
        </div>
      </div>

      <WeekNav selectedDate={selectedDate} />

      <ProgramScheduleGrid
        programs={activePrograms}
        coaches={coachRows}
        resources={resourceRows}
        blocks={blocks}
        seriesById={seriesById}
        selectedDate={selectedDate}
        statuses={reconciliation}
      />

      <AutoRefresh />
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
