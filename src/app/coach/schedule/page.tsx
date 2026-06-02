import Link from "next/link";
import { and, asc, eq, gte, lt } from "drizzle-orm";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { db } from "@/db";
import { programs, programScheduleBlocks } from "@/db/schema";
import { requireSession } from "@/lib/authz";
import {
  formatPfaDate,
  formatPfaDateMedium,
  formatPfaTime,
  formatPfaWeekday,
  parsePfaInput,
  pfaDayStart,
  pfaParts,
} from "@/lib/timezone";

// Coach Schedule page (SCR-2). Read-only weekly agenda of the
// program-schedule blocks the admin set for THIS coach only. No editing,
// no reconciliation green/red — just the coach's own scheduled blocks,
// navigable by week. Pure server component.
//
// Security: scoped to the signed-in coach via
// `scheduledCoachId === session.user.id`. A coach sees ONLY their own
// blocks, never another coach's.
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

  const blockRows = await db
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
    .where(
      and(
        eq(programScheduleBlocks.scheduledCoachId, coachId),
        gte(programScheduleBlocks.startAt, monday),
        lt(programScheduleBlocks.startAt, nextMonday),
      ),
    )
    .orderBy(asc(programScheduleBlocks.startAt));

  // Group blocks by their PFA calendar date.
  const byDay = new Map<string, typeof blockRows>();
  for (const b of blockRows) {
    const key = formatPfaDate(b.startAt);
    const list = byDay.get(key);
    if (list) list.push(b);
    else byDay.set(key, [b]);
  }

  const todayKey = formatPfaDate(new Date());
  const weekIsEmpty = blockRows.length === 0;

  return (
    <div className="max-w-2xl">
      <header className="mb-6">
        <p className="text-xs uppercase tracking-[0.18em] text-fg-muted">
          Schedule
        </p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight">
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
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-line bg-surface py-16 text-center">
          <CalendarDays className="h-8 w-8 text-gold" aria-hidden="true" />
          <p className="text-fg-muted">Nothing scheduled this week.</p>
        </div>
      ) : (
        <ul className="space-y-5">
          {days.map((d) => {
            const key = formatPfaDate(d);
            const dayBlocks = byDay.get(key) ?? [];
            const isToday = key === todayKey;
            const parts = pfaParts(d);
            return (
              <li key={key}>
                <div className="mb-2 flex items-baseline gap-2">
                  <p className="text-[11px] uppercase tracking-[0.14em] text-fg-muted">
                    {formatPfaWeekday(d)}
                  </p>
                  <p className="text-sm font-semibold tabular-nums text-fg">
                    {parts.month}/{parts.day}
                  </p>
                  {isToday ? (
                    <span className="text-[10px] uppercase tracking-[0.14em] text-gold">
                      Today
                    </span>
                  ) : null}
                </div>

                {dayBlocks.length === 0 ? (
                  <p className="text-sm text-fg-subtle">No blocks.</p>
                ) : (
                  <ul className="space-y-2">
                    {dayBlocks.map((b) => (
                      <li
                        key={b.id}
                        className="rounded-md border border-line border-l-2 border-l-gold bg-surface px-4 py-3"
                      >
                        <p className="text-sm font-medium text-fg tabular-nums">
                          {formatPfaTime(b.startAt)}–{formatPfaTime(b.endAt)}
                          <span className="text-fg-muted font-normal">
                            {" "}
                            · {b.programName}
                          </span>
                        </p>
                        {b.note ? (
                          <p className="mt-1 text-xs text-fg-muted">{b.note}</p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
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
      className="inline-flex h-10 w-9 items-center justify-center rounded-md border border-line bg-surface text-fg-muted hover:border-line-strong hover:text-fg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
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
