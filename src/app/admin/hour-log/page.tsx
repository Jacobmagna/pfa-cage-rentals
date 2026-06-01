import Link from "next/link";
import { and, asc, eq, isNull } from "drizzle-orm";
import { ArrowLeft, Download } from "lucide-react";
import { db } from "@/db";
import { programs, users } from "@/db/schema";
import { requireRole } from "@/lib/authz";
import {
  hourLogFiltersToQueryString,
  normalizeHourLogFilters,
} from "@/lib/reports/hour-log-filters";
import { fetchHourLogRows } from "@/lib/reports/hour-log-fetch";
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

  const [rows, coachOptions, programOptions] = await Promise.all([
    fetchHourLogRows(filters),
    // Filter dropdown — coaches role only, active only.
    db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(and(eq(users.role, "coach"), isNull(users.deletedAt)))
      .orderBy(asc(users.name), asc(users.email)),
    db
      .select({ id: programs.id, name: programs.name })
      .from(programs)
      .where(eq(programs.active, true))
      .orderBy(asc(programs.name)),
  ]);

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

      <div className="mb-8 space-y-2">
        <p className="text-xs uppercase tracking-[0.18em] text-fg-muted">
          Admin
        </p>
        <h1 className="text-3xl font-bold tracking-tight">Hour Log</h1>
        <p className="text-sm text-fg-muted">
          Filter and edit logged hours. Defaults to the current month.
        </p>
        <p className="text-xs italic text-fg-subtle md:hidden">
          This page is designed for desktop. Rotate your device or use a
          laptop for the full experience.
        </p>
      </div>

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
          className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-4 h-9 text-sm font-medium text-fg hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
        >
          <Download className="h-4 w-4" />
          Download Excel
        </Link>
      </div>

      <HoursClient
        rows={rows}
        programOptions={programOptions}
      />
    </>
  );
}
