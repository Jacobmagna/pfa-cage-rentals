// GET /admin/reports/download?from=&to=&coachIds=&resourceTypes=
// Builds the Excel workbook and returns it as a download.
//
// Same filter contract as the page (shared via lib/reports/filters.ts)
// so what Dad sees in the browser preview matches the workbook he
// downloads — no surprises.
//
// Note there is deliberately no `tab` here. The page has sub-tabs, but a
// download always contains every category (reports-tabs SPEC §5) — a
// workbook must never be silently narrowed by whichever tab happened to
// be open when the button was clicked.

import { fetchReportData } from "@/lib/reports/fetch";
import {
  filtersFromURLSearchParams,
} from "@/lib/reports/filters";
import { buildReportWorkbook } from "@/lib/reports/excel";
import { fetchHourLogRowsWithScheduleNotes } from "@/lib/reports/hour-log-fetch";
import { hourLogFiltersFromReportFilters } from "@/lib/reports/hour-log-filters";
import { buildWorkReport } from "@/lib/reports/work-report";
import { fetchStipendEarningsInRange } from "@/lib/stipend/fetch";
import { coachScopeFromFilters } from "@/lib/stipend/scope";
import { buildPaymentTimeline } from "@/lib/reports/payments-timeline";
import { fetchPaymentTimelineRows } from "@/lib/reports/payments-timeline-fetch";
import { requireRole } from "@/lib/authz";

export async function GET(request: Request) {
  await requireRole("admin");

  const url = new URL(request.url);
  const filters = filtersFromURLSearchParams(url.searchParams);

  // The SAME three fetches the page runs, from the SAME normalized
  // filters — that shared contract is what makes the preview and the
  // workbook agree row for row. Run them together; they're independent.
  const [report, workRows, paymentRows, stipendEarnings] = await Promise.all([
    fetchReportData(filters),
    fetchHourLogRowsWithScheduleNotes(
      hourLogFiltersFromReportFilters(filters),
    ),
    fetchPaymentTimelineRows({
      fromDate: filters.fromDate,
      toDateExclusive: filters.toDateExclusive,
      coachIds: filters.coachIds,
    }),
    // 🔴 The SAME range + scope the screen uses. The workbook and the Work tab
    // are fed from one builder precisely so they cannot quote different money;
    // fetching stipends here with different arguments would reintroduce that
    // drift through the back door.
    fetchStipendEarningsInRange({
      fromDate: filters.fromDate,
      toDateExclusive: filters.toDateExclusive,
      // 🔴 See `coachScopeFromFilters` — an empty filter means ALL coaches
      // here and NONE in the fetch, and passing it raw emptied the workbook
      // of stipends on the default download.
      coachIds: coachScopeFromFilters(filters.coachIds),
    }),
  ]);

  const buffer = await buildReportWorkbook(
    {
      report,
      work: buildWorkReport(workRows, stipendEarnings),
      payments: buildPaymentTimeline(paymentRows.rows),
      paymentsTruncated: paymentRows.truncated,
    },
    {
      from: filters.from,
      to: filters.to,
    },
  );

  const filename = `pfa-billing-${filters.from}_to_${filters.to}.xlsx`;

  return new Response(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      // Tell browsers not to cache the workbook — Dad re-pulling the
      // same date range after editing a session would otherwise see
      // a stale file.
      "Cache-Control": "no-store",
    },
  });
}
