// GET /admin/reports/download?from=&to=&coachIds=&resourceTypes=
// Builds the Excel workbook and returns it as a download.
//
// Same filter contract as the page (shared via lib/reports/filters.ts)
// so what Dad sees in the browser preview matches the workbook he
// downloads — no surprises.

import { fetchReportData } from "@/lib/reports/fetch";
import {
  filtersFromURLSearchParams,
} from "@/lib/reports/filters";
import { buildReportWorkbook } from "@/lib/reports/excel";
import { requireRole } from "@/lib/authz";

export async function GET(request: Request) {
  await requireRole("admin");

  const url = new URL(request.url);
  const filters = filtersFromURLSearchParams(url.searchParams);
  const report = await fetchReportData(filters);

  const buffer = await buildReportWorkbook(report, {
    from: filters.from,
    to: filters.to,
  });

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
