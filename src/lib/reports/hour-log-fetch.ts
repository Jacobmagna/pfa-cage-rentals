// Shared data-fetch for /admin/hour-log and its download route — the
// page preview and the downloaded workbook must show identical rows.
// Mirrors lib/reports/fetch.ts: takes the normalized filter shape, runs
// the JOIN, returns plain rows. No Next-specific imports, so the route
// handler and the server component both call it.
//
// JOINs are inner — a row can't exist without a coach + program FK
// target. Filtered by the date range (startAt within [fromDate,
// toDateExclusive)) plus the optional single coach / program. Ordered
// by coach name then start so the table reads grouped-by-coach.

import { and, asc, eq, gte, lt } from "drizzle-orm";
import { db } from "@/db";
import { hourLogs, programs, users } from "@/db/schema";
import type { HourLogWorkbookRow } from "./hour-log-excel";
import type { NormalizedHourLogFilters } from "./hour-log-filters";

export async function fetchHourLogRows(
  filters: NormalizedHourLogFilters,
): Promise<HourLogWorkbookRow[]> {
  const conditions = [
    gte(hourLogs.startAt, filters.fromDate),
    lt(hourLogs.startAt, filters.toDateExclusive),
  ];
  if (filters.coachId) {
    conditions.push(eq(hourLogs.coachId, filters.coachId));
  }
  if (filters.programId) {
    conditions.push(eq(hourLogs.programId, filters.programId));
  }

  return db
    .select({
      id: hourLogs.id,
      coachId: hourLogs.coachId,
      coachName: users.name,
      coachEmail: users.email,
      programName: programs.name,
      startAt: hourLogs.startAt,
      endAt: hourLogs.endAt,
      note: hourLogs.note,
    })
    .from(hourLogs)
    .innerJoin(users, eq(hourLogs.coachId, users.id))
    .innerJoin(programs, eq(hourLogs.programId, programs.id))
    .where(and(...conditions))
    .orderBy(asc(users.name), asc(hourLogs.startAt));
}
