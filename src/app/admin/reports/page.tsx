import Link from "next/link";
import { ArrowLeft, Download } from "lucide-react";
import { requireRole } from "@/lib/authz";
import { listActiveCoaches } from "@/lib/server/coaches";
import { fetchReportData } from "@/lib/reports/fetch";
import {
  filtersToQueryString,
  normalizeFilters,
} from "@/lib/reports/filters";
import { FiltersForm } from "./_components/filters-form";
import { ReportPreview } from "./_components/report-preview";

// Admin reports page. Filters live in the URL (`?from=&to=&coachIds=&resourceTypes=`)
// so links are shareable and the browser back button just works.
// Filter parsing + data fetching live in src/lib/reports/* and are
// shared with the download route — what Dad sees in the preview
// matches what the workbook contains, exactly.

type RawSearchParams = Promise<{
  from?: string;
  to?: string;
  coachIds?: string | string[];
  resourceTypes?: string | string[];
  scopeApplied?: string | string[];
  includeCage?: string | string[];
  includeProgram?: string | string[];
}>;

export default async function AdminReportsPage({
  searchParams,
}: {
  searchParams: RawSearchParams;
}) {
  await requireRole("admin");
  const params = await searchParams;

  const filters = normalizeFilters(params);

  // Fetch coaches list (for the filter form) + report data in parallel.
  const [coachOptions, report] = await Promise.all([
    // Reports themselves include historical "Former coach" rows
    // (the report data fetch joins unfiltered). This list is just the
    // filter dropdown — only active coaches need to appear, since the
    // admin can't meaningfully filter to a coach who was deleted before
    // they had a chance to learn the new system.
    listActiveCoaches(),
    fetchReportData(filters),
  ]);

  const downloadHref = `/admin/reports/download?${filtersToQueryString(filters)}`;
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
        values={{
          from: filters.from,
          to: filters.to,
          coachIds: filters.coachIds,
          resourceTypes: filters.resourceTypes,
          includeCageSessions: filters.includeCageSessions,
          includeProgramHours: filters.includeProgramHours,
        }}
      />

      <ReportPreview
        detail={report.detail}
        summary={report.summary}
        grandTotalCents={report.grandTotalCents}
        includeCageSessions={filters.includeCageSessions}
        includeProgramHours={filters.includeProgramHours}
      />
    </>
  );
}
