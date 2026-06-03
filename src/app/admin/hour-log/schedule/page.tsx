import Link from "next/link";
import { and, asc, eq, gt, gte, isNull, lt } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import { db } from "@/db";
import { hourLogs, programs, programScheduleBlocks, users } from "@/db/schema";
import { requireRole } from "@/lib/authz";
import {
  reconcileBlocks,
  type ReconBlock,
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

  const [activePrograms, blockRows, coachRows, logRows] = await Promise.all([
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
      })
      .from(programScheduleBlocks)
      .innerJoin(users, eq(programScheduleBlocks.scheduledCoachId, users.id))
      .where(
        and(
          gte(programScheduleBlocks.startAt, dayStart),
          lt(programScheduleBlocks.startAt, dayEnd),
        ),
      )
      .orderBy(asc(programScheduleBlocks.startAt)),
    db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(and(eq(users.role, "coach"), isNull(users.deletedAt)))
      .orderBy(asc(users.name), asc(users.email)),
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
      .where(and(lt(hourLogs.startAt, dayEnd), gt(hourLogs.endAt, dayStart))),
  ]);

  const blocks = blockRows.map((b) => ({
    id: b.id,
    programId: b.programId,
    scheduledCoachId: b.scheduledCoachId,
    coachName: b.coachName ?? b.coachEmail,
    startAt: b.startAt,
    endAt: b.endAt,
    note: b.note,
  }));

  // Reconcile the day's scheduled blocks against the coach hour-logs
  // (FEAT-16). The engine is pure — we inject `now` + the PFA time
  // formatter here.
  const reconBlocks: ReconBlock[] = blocks.map((b) => ({
    id: b.id,
    programId: b.programId,
    scheduledCoachId: b.scheduledCoachId,
    scheduledCoachName: b.coachName,
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
        href="/admin"
        className="inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg mb-6 transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back
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
        blocks={blocks}
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
