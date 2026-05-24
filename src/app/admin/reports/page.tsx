import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { ArrowLeft, Download } from "lucide-react";
import { db } from "@/db";
import { users } from "@/db/schema";
import { requireRole } from "@/lib/authz";
import { fetchReportData } from "@/lib/reports/fetch";
import {
  filtersToQueryString,
  normalizeFilters,
} from "@/lib/reports/filters";
import { AppShell } from "@/app/_components/app-shell";
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
    db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(eq(users.role, "coach"))
      .orderBy(asc(users.name), asc(users.email)),
    fetchReportData(filters),
  ]);

  const downloadHref = `/admin/reports/download?${filtersToQueryString(filters)}`;
  const hasResults = report.detail.length > 0;

  return (
    <AppShell role="admin">
      <Link
        href="/admin"
        className="inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg mb-6 transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back
      </Link>

      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="space-y-1.5">
          <p className="text-xs uppercase tracking-[0.18em] text-fg-muted">
            Billing reports
          </p>
          <h1 className="text-2xl font-bold tracking-tight">Reports</h1>
          <p className="text-sm text-fg-muted">
            Per-coach billing breakdown by resource type. Defaults to the
            current month.
          </p>
        </div>

        {hasResults ? (
          <a
            href={downloadHref}
            className="inline-flex items-center gap-1.5 rounded-md bg-gold px-4 h-10 text-sm font-medium text-gold-ink hover:bg-gold-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
          >
            <Download className="h-4 w-4" />
            Download Excel
          </a>
        ) : (
          <span
            aria-disabled="true"
            className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-4 h-10 text-sm font-medium text-fg-muted cursor-not-allowed opacity-50"
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
        }}
      />

      <ReportPreview
        detail={report.detail}
        summary={report.summary}
        grandTotalCents={report.grandTotalCents}
      />
    </AppShell>
  );
}
