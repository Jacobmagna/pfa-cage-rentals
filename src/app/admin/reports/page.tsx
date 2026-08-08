import Link from "next/link";
import { ArrowLeft, Download } from "lucide-react";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { programs } from "@/db/schema";
import { requireRole } from "@/lib/authz";
import { listActiveCoaches } from "@/lib/server/coaches";
import { resolveArchivedCoachOptions } from "@/lib/server/archived-coach-options";
import { fetchReportData } from "@/lib/reports/fetch";
import {
  filtersToQueryString,
  normalizeFilters,
} from "@/lib/reports/filters";
import { fetchHourLogRowsWithScheduleNotes } from "@/lib/reports/hour-log-fetch";
import { hourLogFiltersFromReportFilters } from "@/lib/reports/hour-log-filters";
import { buildWorkReport } from "@/lib/reports/work-report";
import { buildPaymentTimeline } from "@/lib/reports/payments-timeline";
import { fetchPaymentTimelineRows } from "@/lib/reports/payments-timeline-fetch";
import { normalizeReportTab } from "@/lib/reports/tabs";
import { FiltersForm } from "./_components/filters-form";
import { ReportsTabs } from "./_components/reports-tabs";
import { ReportPreview } from "./_components/report-preview";
import { WorkPreview } from "./_components/work-preview";
import { PaymentsPreview } from "./_components/payments-preview";

// Admin reports page. Filters live in the URL
// (`?from=&to=&coachIds=&resourceTypes=&tab=`) so links are shareable and
// the browser back button just works. Filter parsing + data fetching live
// in src/lib/reports/* and are shared with the download route — what Dad
// sees in the preview matches what the workbook contains, exactly.
//
// Three sub-tabs (reports-tabs SPEC §3): Cage rentals · Work hours ·
// Payments. The tab selects the VIEW only — the fetch and the download
// are never narrowed by it.

type RawSearchParams = Promise<{
  from?: string;
  to?: string;
  coachIds?: string | string[];
  resourceTypes?: string | string[];
  programId?: string | string[];
  tab?: string | string[];
}>;

export default async function AdminReportsPage({
  searchParams,
}: {
  searchParams: RawSearchParams;
}) {
  await requireRole("admin");
  const params = await searchParams;

  const filters = normalizeFilters(params);
  const activeTab = normalizeReportTab(params.tab);

  // Filter-dropdown options + every tab's data, in parallel.
  const [coachOptions, programOptions, report, workRows, paymentRows] =
    await Promise.all([
    // Reports themselves include historical "Former coach" rows
    // (the report data fetch joins unfiltered). This list is just the
    // filter dropdown — only active coaches need to appear, since the
    // admin can't meaningfully filter to a coach who was deleted before
    // they had a chance to learn the new system.
    listActiveCoaches(),
    // Same convention for programs, matching /admin/hour-log's dropdown:
    // active programs only in the filter, but the fetch joins unfiltered
    // so logs against a since-retired program still report.
    db
      .select({ id: programs.id, name: programs.name })
      .from(programs)
      .where(eq(programs.active, true))
      .orderBy(asc(programs.name)),
    fetchReportData(filters),
    // The EXISTING work-log fetch (SPEC §2) — not a second query written
    // for this tab. The schedule-note variant is the one the Work Log page
    // and the needs-review queue already use.
    fetchHourLogRowsWithScheduleNotes(
      hourLogFiltersFromReportFilters(filters),
    ),
    // Payment audit events. Respects the coach filter + date range; the
    // resource-type and program filters do not apply to payments.
    fetchPaymentTimelineRows({
      fromDate: filters.fromDate,
      toDateExclusive: filters.toDateExclusive,
      coachIds: filters.coachIds,
    }),
  ]);

  // Summary and detail both come out of this one call, off the one row
  // set — so the rows on screen always add up to the total above them.
  const workReport = buildWorkReport(workRows);
  const paymentTimeline = buildPaymentTimeline(paymentRows.rows);

  // The edit dialog's coach <select> is CONTROLLED and `required`, so a
  // payment whose coach is archived (and therefore absent from the active
  // list) renders with nothing selected and simply refuses to submit —
  // safe, but a dead end. The timeline can legitimately surface such a
  // payment, so resolve those coaches in as "(archived)" options. Same
  // helper /admin/hour-log uses for the same reason.
  const timelineCoachIds = paymentTimeline.events
    .map((e) => e.current?.coachId)
    .filter((id): id is string => id !== undefined);
  const paymentCoachOptions = [
    ...coachOptions,
    ...(await resolveArchivedCoachOptions(coachOptions, timelineCoachIds)),
  ];

  const filterQueryString = filtersToQueryString(filters);
  // No `tab` on the download — the workbook always spans every category
  // regardless of which tab is showing (SPEC §5).
  const downloadHref = `/admin/reports/download?${filterQueryString}`;
  // Program-only coaches produce summary rows with no session detail —
  // treat the report as non-empty when either has data.
  const hasResults = report.detail.length > 0 || report.summary.length > 0;

  return (
    <>
      <Link
        href="/admin/records"
        className="inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg mb-6 transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to Billing &amp; Records
      </Link>

      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="space-y-1.5">
          <p className="text-[11.5px] font-semibold uppercase tracking-[0.14em] text-fg-muted">
            Billing reports
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">Reports</h1>
          <p className="text-sm text-fg-muted">
            Per-coach billing breakdown by resource type. Defaults to the
            current month.
          </p>
          <p className="text-xs italic text-fg-subtle md:hidden">
            This page is designed for desktop. Rotate your device or use a
            laptop for the full experience.
          </p>
        </div>

        {hasResults ? (
          <a
            href={downloadHref}
            className="inline-flex items-center gap-1.5 rounded-lg bg-gold px-4 h-10 text-sm font-medium text-gold-ink shadow-[var(--shadow-sm)] hover:bg-gold-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
          >
            <Download className="h-4 w-4" />
            Download Excel
          </a>
        ) : (
          <span
            aria-disabled="true"
            className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-4 h-10 text-sm font-medium text-fg-muted cursor-not-allowed opacity-50"
            title="No sessions to export"
          >
            <Download className="h-4 w-4" />
            Download Excel
          </span>
        )}
      </div>

      <FiltersForm
        coaches={coachOptions}
        programs={programOptions}
        activeTab={activeTab}
        values={{
          from: filters.from,
          to: filters.to,
          coachIds: filters.coachIds,
          resourceTypes: filters.resourceTypes,
          programId: filters.programId ?? "",
        }}
      />

      <ReportsTabs
        activeTab={activeTab}
        filterQueryString={filterQueryString}
      />

      {activeTab === "cage" ? (
        <ReportPreview
          detail={report.detail}
          summary={report.summary}
          grandTotalCents={report.grandTotalCents}
        />
      ) : activeTab === "work" ? (
        <WorkPreview
          detail={workReport.detail}
          summary={workReport.summary}
          grandTotalCents={workReport.grandTotalCents}
          grandTotalHours={workReport.grandTotalHours}
        />
      ) : (
        <PaymentsPreview
          events={paymentTimeline.events}
          totals={paymentTimeline.totals}
          truncated={paymentRows.truncated}
          coachOptions={paymentCoachOptions}
        />
      )}
    </>
  );
}
