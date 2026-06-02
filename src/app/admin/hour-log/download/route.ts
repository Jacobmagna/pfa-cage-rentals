// GET /admin/hour-log/download?from=&to=&coachId=&programId=
// Builds the hour-log Excel workbook and returns it as a download.
//
// Same filter contract as the page (shared via
// lib/reports/hour-log-filters.ts) and the same row fetch
// (fetchHourLogRows), so what the admin sees in the browser preview
// matches the workbook they download — no surprises.

import { requireRole } from "@/lib/authz";
import { hourLogFiltersFromURLSearchParams } from "@/lib/reports/hour-log-filters";
import { buildHourLogWorkbook } from "@/lib/reports/hour-log-excel";
import { fetchHourLogRowsWithScheduleNotes } from "@/lib/reports/hour-log-fetch";

export async function GET(request: Request) {
  await requireRole("admin");

  const url = new URL(request.url);
  const filters = hourLogFiltersFromURLSearchParams(url.searchParams);
  const rows = await fetchHourLogRowsWithScheduleNotes(filters);

  const buffer = await buildHourLogWorkbook(rows, {
    from: filters.from,
    to: filters.to,
  });

  const filename = `pfa-hours-${filters.from}_to_${filters.to}.xlsx`;

  return new Response(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      // Tell browsers not to cache the workbook — re-pulling the same
      // date range after editing an entry would otherwise see a stale
      // file.
      "Cache-Control": "no-store",
    },
  });
}
