// Shared data-fetching for /admin/reports and its download route.
// Takes the normalized filter shape, runs the SQL + aggregate
// pipeline, returns ReportData. Pure dependency on Drizzle + the
// aggregator — no Next-specific imports, so route handlers and
// server components both call it.

import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import { db } from "@/db";
import { hourLogs, resources, sessionsBilling, users } from "@/db/schema";
import {
  aggregateReport,
  type AggregateHourLogInput,
  type AggregateSessionInput,
  type ReportData,
} from "./aggregate";
import type { NormalizedFilters } from "./filters";

export async function fetchReportData(
  filters: NormalizedFilters,
): Promise<ReportData> {
  const conditions = [
    gte(sessionsBilling.startAt, filters.fromDate),
    lt(sessionsBilling.startAt, filters.toDateExclusive),
  ];
  if (filters.coachIds.length > 0) {
    conditions.push(inArray(sessionsBilling.coachId, filters.coachIds));
  }
  // Skip the resource-type WHERE when all three are selected — the
  // query planner doesn't care, but keeping the SQL tight reads
  // better in logs.
  if (
    filters.resourceTypes.length > 0 &&
    filters.resourceTypes.length < 3
  ) {
    conditions.push(inArray(resources.type, filters.resourceTypes));
  }

  // Snapshot rule: read ratePer30MinCents directly off the session
  // row. No override fetch — overrides are only consulted at session
  // CREATION time (in src/lib/server/session-actions.ts), never on
  // the read path.
  //
  // Scope gate: when the "Cage rental sessions" box is off, skip the
  // session query entirely (cleaner than a false WHERE) — the aggregate
  // keeps cage/program separate so empty inputs leave those fields 0.
  const sessionRows = !filters.includeCageSessions
    ? []
    : await db
    .select({
      sessionId: sessionsBilling.id,
      coachId: sessionsBilling.coachId,
      coachName: users.name,
      coachEmail: users.email,
      resourceId: sessionsBilling.resourceId,
      resourceName: resources.name,
      resourceType: resources.type,
      startAt: sessionsBilling.startAt,
      endAt: sessionsBilling.endAt,
      note: sessionsBilling.note,
      ratePer30MinCents: sessionsBilling.ratePer30MinCents,
    })
    .from(sessionsBilling)
    .innerJoin(resources, eq(sessionsBilling.resourceId, resources.id))
    .innerJoin(users, eq(sessionsBilling.coachId, users.id))
    .where(and(...conditions))
    .orderBy(asc(sessionsBilling.startAt));

  // Program hours: same date window as sessions, plus the coach filter
  // when one is set. Program hours aren't a resource type, so a
  // resource-type filter (cage/bullpen/weight_room) naturally excludes
  // them — only fetch when the view spans all resource types. AND that
  // existing coupling with the new "Program hours" scope box.
  const effectiveIncludeProgram =
    filters.includeProgramHours &&
    (filters.resourceTypes.length === 0 || filters.resourceTypes.length === 3);
  const hourLogConditions = [
    gte(hourLogs.startAt, filters.fromDate),
    lt(hourLogs.startAt, filters.toDateExclusive),
  ];
  if (filters.coachIds.length > 0) {
    hourLogConditions.push(inArray(hourLogs.coachId, filters.coachIds));
  }
  const hourLogRows = effectiveIncludeProgram
    ? await db
        .select({
          coachId: hourLogs.coachId,
          coachName: users.name,
          coachEmail: users.email,
          startAt: hourLogs.startAt,
          endAt: hourLogs.endAt,
          ratePer30MinCents: hourLogs.ratePer30MinCents,
        })
        .from(hourLogs)
        .innerJoin(users, eq(hourLogs.coachId, users.id))
        .where(and(...hourLogConditions))
        .orderBy(asc(hourLogs.startAt))
    : [];

  const hourLogInputs: AggregateHourLogInput[] = hourLogRows.map((r) => ({
    coachId: r.coachId,
    coachName: r.coachName,
    coachEmail: r.coachEmail,
    startAt: r.startAt,
    endAt: r.endAt,
    ratePer30MinCents: r.ratePer30MinCents ?? 0,
  }));

  const aggregateInputs: AggregateSessionInput[] = sessionRows.map((r) => ({
    sessionId: r.sessionId,
    coachId: r.coachId,
    coachName: r.coachName,
    coachEmail: r.coachEmail,
    resourceId: r.resourceId,
    resourceName: r.resourceName,
    resourceType: r.resourceType,
    startAt: r.startAt,
    endAt: r.endAt,
    note: r.note,
    ratePer30MinCents: r.ratePer30MinCents,
  }));

  return aggregateReport(aggregateInputs, hourLogInputs);
}
