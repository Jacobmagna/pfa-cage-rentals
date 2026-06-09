import Link from "next/link";
import { and, asc, eq, gte, lt } from "drizzle-orm";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { db } from "@/db";
import {
  programs,
  programScheduleBlockCoaches,
  programScheduleBlocks,
  resources,
  sessionsBilling,
} from "@/db/schema";
import { requireSession } from "@/lib/authz";
import {
  formatPfaDate,
  formatPfaDateMedium,
  formatPfaWeekday,
  parsePfaInput,
  pfaDayStart,
  pfaParts,
} from "@/lib/timezone";
import {
  CoachWeekGrid,
  type CoachGridDay,
  type CoachGridProgramBlock,
  type CoachGridSession,
} from "./_components/coach-week-grid";
import { CoachWeekAgenda } from "./_components/coach-week-agenda";

// Coach Schedule page (SCR-2). Read-only WEEK time-grid (QA10 W3.4): days
// across the top, time of day down the rows. Shows, for THIS coach only,
// both the program-schedule blocks the admin set for them AND their own
// cage-rental sessions. No editing, no reconciliation green/red — just the
// coach's own week, navigable by week. Pure server component.
//
// Security: scoped to the signed-in coach. Program blocks are filtered by
// scheduled-coach membership; cage sessions by `coachId === session.user.id`.
// A coach sees ONLY their own blocks and sessions, never another coach's.
//
// URL state: ?date=YYYY-MM-DD (defaults to today).

const DAY_MS = 24 * 60 * 60 * 1000;

type SearchParams = Promise<{ date?: string }>;

export default async function CoachSchedulePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const session = await requireSession();
  const coachId = session.user.id;

  const params = await searchParams;
  const selectedDate = parseDateInput(params.date) ?? startOfToday();

  // DST-safe Monday-start week math (mirrors admin week-nav.tsx; the
  // +0.5-day snap-to-pfaDayStart handles 23h/25h DST days cleanly).
  const monday = pfaWeekStart(selectedDate);
  const days = Array.from({ length: 7 }, (_, i) =>
    pfaDayStart(new Date(monday.getTime() + (i + 0.5) * DAY_MS)),
  );
  days[0] = monday; // exact, no rounding error on day 0
  const sunday = days[6];
  const nextMonday = pfaDayStart(new Date(monday.getTime() + 7.5 * DAY_MS));
  const prevMonday = pfaDayStart(new Date(monday.getTime() - 6.5 * DAY_MS));

  const [blockRows, sessionRows] = await Promise.all([
    db
      .select({
        id: programScheduleBlocks.id,
        programId: programScheduleBlocks.programId,
        programName: programs.name,
        startAt: programScheduleBlocks.startAt,
        endAt: programScheduleBlocks.endAt,
        note: programScheduleBlocks.note,
      })
      .from(programScheduleBlocks)
      .innerJoin(programs, eq(programScheduleBlocks.programId, programs.id))
      // QA10 W3.2: a coach sees a block if they're in its scheduled-coach SET
      // (not only when they're the primary). JOIN the coach set and filter on
      // membership. One row per block (the join is keyed (block, coach), and
      // we filter to this coach, so it can't fan out).
      .innerJoin(
        programScheduleBlockCoaches,
        eq(programScheduleBlockCoaches.blockId, programScheduleBlocks.id),
      )
      .where(
        and(
          eq(programScheduleBlockCoaches.coachId, coachId),
          gte(programScheduleBlocks.startAt, monday),
          lt(programScheduleBlocks.startAt, nextMonday),
        ),
      )
      .orderBy(asc(programScheduleBlocks.startAt)),
    // QA10 W3.4: this coach's own cage-rental sessions for the same week.
    db
      .select({
        id: sessionsBilling.id,
        resourceName: resources.name,
        resourceType: resources.type,
        startAt: sessionsBilling.startAt,
        endAt: sessionsBilling.endAt,
      })
      .from(sessionsBilling)
      .innerJoin(resources, eq(sessionsBilling.resourceId, resources.id))
      .where(
        and(
          eq(sessionsBilling.coachId, coachId),
          gte(sessionsBilling.startAt, monday),
          lt(sessionsBilling.startAt, nextMonday),
        ),
      )
      .orderBy(asc(sessionsBilling.startAt)),
  ]);

  // Map each item to its 0–6 day index within the visible week by matching
  // its PFA calendar date against the days[] array. Items whose date isn't
  // one of the 7 are dropped (shouldn't happen given the where-clauses).
  const dayIndexByDate = new Map<string, number>();
  days.forEach((d, i) => dayIndexByDate.set(formatPfaDate(d), i));

  const gridDays: CoachGridDay[] = days.map((d) => {
    const parts = pfaParts(d);
    return {
      date: d,
      weekdayLabel: formatPfaWeekday(d),
      dayLabel: `${parts.month}/${parts.day}`,
      isToday: formatPfaDate(d) === formatPfaDate(new Date()),
    };
  });

  const gridProgramBlocks: CoachGridProgramBlock[] = blockRows.flatMap((b) => {
    const dayIndex = dayIndexByDate.get(formatPfaDate(b.startAt));
    if (dayIndex === undefined) return [];
    return [
      {
        id: b.id,
        dayIndex,
        programName: b.programName,
        startAt: b.startAt,
        endAt: b.endAt,
        note: b.note,
      },
    ];
  });

  const gridSessions: CoachGridSession[] = sessionRows.flatMap((s) => {
    const dayIndex = dayIndexByDate.get(formatPfaDate(s.startAt));
    if (dayIndex === undefined) return [];
    return [
      {
        id: s.id,
        dayIndex,
        resourceName: s.resourceName,
        resourceType: s.resourceType,
        startAt: s.startAt,
        endAt: s.endAt,
      },
    ];
  });

  const weekIsEmpty = blockRows.length === 0 && sessionRows.length === 0;

  return (
    <div className="max-w-6xl mx-auto">
      <header className="mb-6">
        <p className="text-xs uppercase tracking-[0.18em] text-fg-muted">
          Schedule
        </p>
        <h1 className="mt-2 text-2xl sm:text-3xl font-bold tracking-tight">
          Week of {formatPfaDateMedium(monday)} – {formatPfaDateMedium(sunday)}
        </h1>
      </header>

      <nav
        aria-label="Week navigation"
        className="mb-6 flex items-center justify-between gap-2"
      >
        <WeekLink
          href={`?date=${formatPfaDate(prevMonday)}`}
          dir="left"
          label="Previous week"
        />
        <p className="text-sm font-medium text-fg-muted tabular-nums">
          {formatPfaDateMedium(monday)} – {formatPfaDateMedium(sunday)}
        </p>
        <WeekLink
          href={`?date=${formatPfaDate(nextMonday)}`}
          dir="right"
          label="Next week"
        />
      </nav>

      {weekIsEmpty ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)] py-16 text-center">
          <CalendarDays className="h-8 w-8 text-gold" aria-hidden="true" />
          <p className="text-fg-muted">Nothing scheduled this week.</p>
        </div>
      ) : (
        <>
          {/* Desktop: read-only week time-grid (unchanged). */}
          <div className="hidden md:block">
            <CoachWeekGrid
              days={gridDays}
              programBlocks={gridProgramBlocks}
              sessions={gridSessions}
            />
          </div>
          {/* Mobile: vertical day-by-day agenda (same props). */}
          <div className="md:hidden">
            <CoachWeekAgenda
              days={gridDays}
              programBlocks={gridProgramBlocks}
              sessions={gridSessions}
            />
          </div>
        </>
      )}
    </div>
  );
}

function WeekLink({
  href,
  dir,
  label,
}: {
  href: string;
  dir: "left" | "right";
  label: string;
}) {
  const Icon = dir === "left" ? ChevronLeft : ChevronRight;
  return (
    <Link
      href={href}
      aria-label={label}
      className="inline-flex h-10 w-9 items-center justify-center rounded-lg border border-line bg-surface text-fg-muted shadow-[var(--shadow-sm)] hover:-translate-y-px hover:border-gold/40 hover:text-gold-strong hover:shadow-[var(--shadow-md)] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
    >
      <Icon className="h-4 w-4" />
    </Link>
  );
}

function parseDateInput(s: string | undefined): Date | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return parsePfaInput(s, "00:00");
}

function startOfToday(): Date {
  return pfaDayStart(new Date());
}

// Returns PFA midnight of the Monday in the PFA week containing d.
// Mirrors admin week-nav.tsx's pfaWeekStart (ISO week = Monday-start).
function pfaWeekStart(d: Date): Date {
  const dayMidnight = pfaDayStart(d);
  const dayOfWeek = dayMidnight.getUTCDay(); // 0=Sun..6=Sat
  const offsetDays = (dayOfWeek + 6) % 7; // days back to Monday
  return pfaDayStart(
    new Date(dayMidnight.getTime() - (offsetDays - 0.5) * DAY_MS),
  );
}
