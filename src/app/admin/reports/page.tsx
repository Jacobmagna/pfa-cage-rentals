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
import { fetchStipendEarningsInRange } from "@/lib/stipend/fetch";
import { coachScopeFromFilters } from "@/lib/stipend/scope";
import { buildPaymentTimeline } from "@/lib/reports/payments-timeline";
import { fetchPaymentTimelineRows } from "@/lib/reports/payments-timeline-fetch";
import { normalizeReportTab } from "@/lib/reports/tabs";
import {
  buildStatementPair,
  buildStatementRoster,
  statementPeriodLabel,
} from "@/lib/statement/engine";
import {
  fetchStatementCoaches,
  singleCoachInScope,
} from "@/lib/statement/fetch";
import { statementHref } from "@/lib/statement/links";
import { statementPeriodPresets } from "@/lib/statement/period";
import { normalizeStatementAccount } from "@/lib/statement/types";
import { FiltersForm } from "./_components/filters-form";
import { ReportsTabs } from "./_components/reports-tabs";
import { ReportPreview } from "./_components/report-preview";
import { WorkPreview } from "./_components/work-preview";
import { PaymentsPreview } from "./_components/payments-preview";
import { StatementCard } from "./_components/statement-card";
import { StatementRoster } from "./_components/statement-roster";

// Admin reports page. Filters live in the URL
// (`?from=&to=&coachIds=&resourceTypes=&tab=`) so links are shareable and
// the browser back button just works. Filter parsing + data fetching live
// in src/lib/reports/* and are shared with the download route — what Dad
// sees in the preview matches what the workbook contains, exactly.
//
// FOUR sub-tabs (reports-tabs SPEC §3 + payment-statement SPEC §8): Cage
// rentals · Work hours · Payments · Statements. The tab selects the VIEW
// only — the fetch and the download are never narrowed by it.
//
// `?account=cage|work` picks which of a coach's two statements is on screen
// (payment-statement SPEC §5.0). Like `tab`, it is deliberately NOT part of
// `NormalizedFilters`: it chooses between two already-computed documents and
// must never be able to narrow a query or a workbook sheet.

type RawSearchParams = Promise<{
  from?: string;
  to?: string;
  coachIds?: string | string[];
  resourceTypes?: string | string[];
  programId?: string | string[];
  tab?: string | string[];
  account?: string | string[];
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
  const account = normalizeStatementAccount(params.account);

  // Filter-dropdown options + every tab's data, in parallel.
  const [
    coachOptions,
    programOptions,
    report,
    workRows,
    paymentRows,
    statementCoaches,
  ] = await Promise.all([
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
    // ⚠️ The one fetch gated on the tab, and the distinction matters. The tab
    // still narrows NO filter, NO predicate and NO query's results — the rule
    // `tabs.ts` documents holds. It only decides whether an ENTIRE view's data
    // is read at all, and this one is deliberately unbounded in time (the
    // engine computes opening balances from history, so it needs all of it),
    // which makes it the one fetch it would be wasteful to run for three tabs
    // that cannot display it.
    activeTab === "statements"
      ? fetchStatementCoaches({ coachIds: filters.coachIds })
      : Promise.resolve([]),
  ]);

  // Stipends earned in any pay period OVERLAPPING the filter range. ⚠️
  // Overlap, not containment — a stipend is owed for a whole half-month and is
  // not pro-ratable, so a 10-day filter can legitimately show two of them.
  // Every stipend row prints its own period label so that reads as a fact
  // rather than a double-count.
  const stipendEarnings = await fetchStipendEarningsInRange({
    fromDate: filters.fromDate,
    toDateExclusive: filters.toDateExclusive,
    // 🔴 `coachScopeFromFilters`, NOT `filters.coachIds`. An empty filter means
    // ALL coaches here and NONE in the fetch — passing it raw made every
    // stipend disappear from the default view. See the note on the helper.
    coachIds: coachScopeFromFilters(filters.coachIds),
  });

  // Summary and detail both come out of this one call, off the one row
  // set — so the rows on screen always add up to the total above them.
  // Stipends go IN here, as detail rows, for exactly that reason.
  const workReport = buildWorkReport(workRows, stipendEarnings);
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

  // payment-statement SPEC §8.1 — ONE coach in scope gets that coach's
  // statement; zero or many get the ranged-and-netted roll-up, which is the
  // NORMAL state rather than a degraded one, because Mark arrives here from the
  // filter bar with every coach selected.
  const statementCoach = singleCoachInScope(
    filters.coachIds,
    statementCoaches,
  );
  const statementPeriod = {
    fromDate: filters.fromDate,
    toDateExclusive: filters.toDateExclusive,
  };

  const filterQueryString = filtersToQueryString(filters);
  // No `tab` on the download — the workbook always spans every category
  // regardless of which tab is showing (SPEC §5).
  const downloadHref = `/admin/reports/download?${filterQueryString}`;
  // Program-only coaches produce summary rows with no session detail —
  // treat the report as non-empty when either has data.
  const hasResults = report.detail.length > 0 || report.summary.length > 0;

  return (
    <>
      {/* 🔴 EVERY `data-print-hide` below was added in Phase D after RENDERING
          THE STATEMENT TO PDF AND READING IT (SPEC §9, §12.7). The mock was
          verified on a standalone `/admin/reports/statement-preview` page, which
          had none of this chrome; §8 then moved the statement onto the real
          Reports page, and the print stylesheet only knew about `AppShell`'s
          header/footer and `StatementCard`'s own top block. So the FIRST print
          of the shipped statement carried the back link, the page title, the
          Download-Excel button, the entire filter bar and the tab strip onto
          paper — the exact failure §9 forbids ("hide app chrome (nav, filter
          chips, buttons, the edit affordances)"), invisible on screen and
          invisible to a green test run.

          Every attribute here is INERT unless <body> carries
          `printing-document`, which only the statement views set — so printing
          the Cage, Work and Payments tabs is unchanged. */}
      <Link
        data-print-hide
        href="/admin/records"
        className="inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg mb-6 transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to Billing &amp; Records
      </Link>

      <div data-print-hide className="mb-6 flex items-start justify-between gap-4">
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

      {/* The filter bar and the tab strip are the two things SPEC §9 names
          explicitly ("filter chips", "tab strip"). Wrapped rather than marked
          inside the components, because both are shared by all four tabs and
          neither should have to know that one of them prints. */}
      <div data-print-hide>
        <FiltersForm
          coaches={coachOptions}
          programs={programOptions}
          activeTab={activeTab}
          account={account}
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
          account={account}
        />
      </div>

      {/* ONE BRANCH PER TAB, exhaustively — never an `else` that renders some
          other tab's content. This was a two-level ternary whose final `else`
          was the payments timeline, so the moment `REPORT_TABS` gained
          "statements" the tab strip grew a link that silently rendered the
          payments audit feed under a "Statements" heading. A money screen
          showing the wrong money screen is exactly the class of defect that
          survives a green test run, so the fallback is now a visible,
          named-tab error rather than a plausible-looking page. */}
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
      ) : activeTab === "payments" ? (
        <PaymentsPreview
          events={paymentTimeline.events}
          totals={paymentTimeline.totals}
          truncated={paymentRows.truncated}
          coachOptions={paymentCoachOptions}
        />
      ) : activeTab === "statements" ? (
        <>
          {/* Resource types and program are the two filters a statement
              cannot honour (see statement/fetch.ts): the document reconciles
              to the all-time, all-resources balance /admin/payments shows, so
              narrowing it would tie out to a number that exists nowhere else.
              Said out loud, because a filter that is silently ignored is worse
              than one that is absent. */}
          <p data-print-hide className="mb-4 text-xs text-fg-subtle">
            Statements use the date range and the coach filter. The resource-type
            and program filters do not apply — each account&rsquo;s statement
            covers that whole ledger, which is what lets it reconcile to the
            all-time balance on{" "}
            <Link href="/admin/payments" className="underline hover:text-fg">
              Payments
            </Link>
            .
          </p>

          {statementCoach ? (
            <StatementCard
              pair={buildStatementPair({
                coachName: statementCoach.coachName,
                coachEmail: statementCoach.coachEmail,
                period: statementPeriod,
                cageCharges: statementCoach.cageCharges,
                workCharges: statementCoach.workCharges,
                payments: statementCoach.payments,
              })}
              account={account}
              // Both link builders preserve the filters that are on screen —
              // a switcher that dropped the period would show a different
              // month's arithmetic under the same header.
              hrefForAccount={(a) => statementHref(filters, a)}
              periodChips={statementPeriodPresets(new Date()).map((preset) => ({
                label: preset.label,
                href: statementHref(filters, account, {
                  from: preset.from,
                  to: preset.to,
                }),
                // A chip is current only when it matches BOTH ends of the
                // range, so a hand-typed partial month highlights nothing
                // rather than claiming to be a whole month.
                active:
                  filters.from === preset.from && filters.to === preset.to,
              }))}
            />
          ) : (
            <StatementRoster
              rows={buildStatementRoster({
                period: statementPeriod,
                coaches: statementCoaches,
              })}
              periodLabel={statementPeriodLabel(statementPeriod)}
              hrefForCoach={(coachId) =>
                statementHref(filters, account, { coachIds: [coachId] })
              }
            />
          )}
        </>
      ) : (
        // Unreachable while `normalizeReportTab` only returns members of
        // `REPORT_TABS` — which is the point. A future fifth tab lands HERE,
        // loudly, instead of inheriting whichever view happened to be last.
        <div className="rounded-xl border border-dashed border-line-strong bg-surface p-8 text-center text-sm text-fg-subtle">
          No view is wired for the <span className="font-medium">{activeTab}</span>{" "}
          tab.
        </div>
      )}
    </>
  );
}
