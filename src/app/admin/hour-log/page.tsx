import Link from "next/link";
import { and, asc, eq, gte, lt, sql as drizzleSql } from "drizzle-orm";
import {
  ArrowLeft,
  CalendarDays,
  ChevronRight,
  Clock,
  Download,
  TimerReset,
  Wallet,
} from "lucide-react";
import { db } from "@/db";
import { hourLogs, programScheduleBlocks, programs } from "@/db/schema";
import { requireRole } from "@/lib/authz";
import { listActiveCoaches } from "@/lib/server/coaches";
import {
  hourLogFiltersToQueryString,
  normalizeHourLogFilters,
} from "@/lib/reports/hour-log-filters";
import { fetchHourLogRowsWithScheduleNotes } from "@/lib/reports/hour-log-fetch";
import { countHeldHourLogs } from "@/lib/server/hour-log-actions";
import { programMinutes, programPayFromSnapshot } from "@/lib/billing";
import { formatDollars } from "@/lib/format-money";
import { pfaDayEnd, pfaDayStart, pfaMonthEnd, pfaMonthStart } from "@/lib/timezone";
import { fetchNeedsReviewItems } from "@/lib/server/needs-review";
import { StatCard } from "@/app/_components/stat-card";
import { NeedsReviewCard } from "@/app/admin/_components/needs-review-card";
import { FiltersForm } from "./_components/filters-form";
import { HoursClient } from "./_components/hours-client";

// Admin hour-log page. Filterable row-level view of every logged hour —
// the admin counterpart to the coach-side /coach/hour-log form. All
// filter state lives in the URL, so the page is shareable and the
// browser back button works.
//
// Default window is the current PFA-calendar month (shared with the
// download route via lib/reports/hour-log-filters.ts).
//
// Coach + program filter dropdowns list active coaches / active
// programs, but the table joins unfiltered — so entries by a since-
// deleted coach or against a since-retired program still appear and can
// still be edited / deleted.

type RawSearchParams = Promise<{
  from?: string | string[];
  to?: string | string[];
  coachId?: string | string[];
  programId?: string | string[];
}>;

export default async function AdminHourLogPage({
  searchParams,
}: {
  searchParams: RawSearchParams;
}) {
  await requireRole("admin");
  const params = await searchParams;

  const filters = normalizeHourLogFilters(params);

  // Glance-row windows. Same PFA-calendar derivation as /admin/page.tsx:
  // a [start, end) half-open window for both "today" and "this month".
  // These power the 3 program-scoped StatCards only; the table below
  // keeps reading its own URL-driven filter window.
  const now = new Date();
  const dayStart = pfaDayStart(now);
  const dayEnd = pfaDayEnd(now);
  const monthStart = pfaMonthStart(now);
  const monthEndExclusive = pfaMonthEnd(now);

  const [
    rows,
    coachOptions,
    programOptions,
    monthHourLogRows,
    [{ count: programsScheduledToday }],
    reviewItems,
    heldCount,
  ] = await Promise.all([
    fetchHourLogRowsWithScheduleNotes(filters),
    // Filter dropdown — coaches role only, active only.
    listActiveCoaches(),
    db
      .select({ id: programs.id, name: programs.name })
      .from(programs)
      .where(eq(programs.active, true))
      .orderBy(asc(programs.name)),
    // Glance cards 1 + 2: every program hour-log row that STARTS within
    // the current PFA-calendar month. Carries the snapshotted rate so
    // the owed total reads the historical pay (never recomputes).
    db
      .select({
        startAt: hourLogs.startAt,
        endAt: hourLogs.endAt,
        ratePer30MinCents: hourLogs.ratePer30MinCents,
      })
      .from(hourLogs)
      .where(
        and(
          // 1b security B: held logs are not payable until approved.
          eq(hourLogs.status, "posted"),
          gte(hourLogs.startAt, monthStart),
          lt(hourLogs.startAt, monthEndExclusive),
        ),
      ),
    // Glance card 3: distinct programs with a schedule block starting
    // today. Same raw-SQL count style as /admin/page.tsx.
    db
      .select({
        count: drizzleSql<number>`count(distinct ${programScheduleBlocks.programId})::int`,
      })
      .from(programScheduleBlocks)
      .where(
        and(
          gte(programScheduleBlocks.startAt, dayStart),
          lt(programScheduleBlocks.startAt, dayEnd),
        ),
      ),
    // QA1b-p4 #16: the unified Needs-review queue, surfaced on this page too
    // (same merged list the Home dashboard shows), so admins can triage from
    // the Work Log without bouncing back to Home.
    fetchNeedsReviewItems(now),
    // 1b security B: count of HELD manual logs awaiting approval — powers the
    // entry-point card below (rendered only when > 0).
    countHeldHourLogs(),
  ]);

  // Card 1: program hours this month — EXACT duration (a 45-min block is
  // 0.75 hr), not 30-min-slot-rounded.
  // Card 2: program pay PFA owes coaches this month — per-hour × exact
  // duration, treating a null stamped rate as $0 (the "$0 pay" convention).
  let monthMinutes = 0;
  let owedProgramCents = 0;
  for (const r of monthHourLogRows) {
    monthMinutes += programMinutes(r.startAt, r.endAt);
    owedProgramCents += programPayFromSnapshot(
      r.startAt,
      r.endAt,
      r.ratePer30MinCents ?? 0,
    );
  }
  const monthHours = monthMinutes / 60;
  // Up to 2 decimals, trailing zeros stripped: 42.75 → "42.75", 42.5 → "42.5", 40 → "40".
  const monthHoursLabel = monthHours
    .toFixed(2)
    .replace(/\.?0+$/, "");
  const monthEntryCount = monthHourLogRows.length;

  const downloadHref = `/admin/hour-log/download?${hourLogFiltersToQueryString(filters)}`;

  return (
    <>
      <Link
        href="/admin"
        className="inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg mb-6 transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back
      </Link>

      <header className="mb-8 space-y-2">
        <p className="text-[11.5px] font-semibold uppercase tracking-[0.14em] text-fg-muted">
          Admin
        </p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">Work Log</h1>
        <p className="text-sm text-fg-muted">
          Work hours logged by coaches. Filter and edit below; defaults
          to the current month.
        </p>
        <p className="text-xs italic text-fg-subtle md:hidden">
          This page is designed for desktop. Rotate your device or use a
          laptop for the full experience.
        </p>
      </header>

      {heldCount > 0 ? (
        <Link
          href="/admin/hour-log/held"
          className="mb-6 flex items-center gap-3 rounded-xl border border-line-strong bg-surface px-4 py-3.5 shadow-[var(--shadow-sm)] hover:bg-surface-2 hover:-translate-y-px hover:shadow-[var(--shadow-md)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gold/10 text-fg">
            <TimerReset className="h-4.5 w-4.5" aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-fg">
              Held work logs ({heldCount})
            </span>
            <span className="block text-xs text-fg-muted">
              Manual logs coaches flagged for approval — review to make them
              payable.
            </span>
          </span>
          <ChevronRight
            className="h-4 w-4 shrink-0 text-fg-subtle"
            aria-hidden="true"
          />
        </Link>
      ) : null}

      {reviewItems.length > 0 ? (
        <NeedsReviewCard
          items={reviewItems}
          totalCount={reviewItems.length}
        />
      ) : null}

      <section
        aria-label="Work hours at a glance"
        className="mb-10 grid gap-4 sm:grid-cols-3"
      >
        <StatCard
          icon={<Clock className="h-4 w-4" />}
          label="Work hours this month"
          value={monthHoursLabel}
          sub={`${monthEntryCount} ${monthEntryCount === 1 ? "entry" : "entries"} this month`}
        />
        <StatCard
          icon={<Wallet className="h-4 w-4" />}
          label="Owed to coaches — work"
          value={formatDollars(owedProgramCents)}
          sub="PFA owes coaches for work hours"
          accent
        />
        <StatCard
          icon={<CalendarDays className="h-4 w-4" />}
          label="Work scheduled today"
          value={programsScheduledToday.toString()}
          sub={programsScheduledToday > 0 ? "Scheduled" : "Nothing scheduled"}
        />
      </section>

      <FiltersForm
        coaches={coachOptions}
        programs={programOptions}
        values={{
          from: filters.from,
          to: filters.to,
          coachId: filters.coachId ?? "",
          programId: filters.programId ?? "",
        }}
        isFiltered={filters.isFiltered}
      />

      <div className="mb-4 flex items-center justify-end">
        <Link
          href={downloadHref}
          prefetch={false}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-4 h-9 text-sm font-medium text-fg-muted shadow-[var(--shadow-sm)] hover:text-fg hover:-translate-y-px hover:shadow-[var(--shadow-md)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition"
        >
          <Download className="h-4 w-4" />
          Download Excel
        </Link>
      </div>

      <HoursClient
        rows={rows.map((r) => ({
          ...r,
          unscheduled: r.unscheduled ?? false,
          reviewedAt: r.reviewedAt ?? null,
          reviewedBy: r.reviewedBy ?? null,
        }))}
        programOptions={programOptions}
      />
    </>
  );
}
