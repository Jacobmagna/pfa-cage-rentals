import Link from "next/link";
import { and, asc, eq, gte, isNull, lt } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import { db } from "@/db";
import { programs, programScheduleBlocks, users } from "@/db/schema";
import { requireRole } from "@/lib/authz";
import { formatPfaDateLong, parsePfaInput, pfaDayEnd, pfaDayStart } from "@/lib/timezone";
import { AutoRefresh } from "../_components/auto-refresh";
import { WeekNav } from "../_components/week-nav";
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

  const [activePrograms, blockRows, coachRows] = await Promise.all([
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
          <p className="text-xs uppercase tracking-[0.18em] text-fg-muted">
            Schedule
          </p>
          <h1 className="text-2xl font-bold tracking-tight">{dateLabel}</h1>
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
