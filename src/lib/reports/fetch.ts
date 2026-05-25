// Shared data-fetching for /admin/reports and its download route.
// Takes the normalized filter shape, runs the SQL + aggregate
// pipeline, returns ReportData. Pure dependency on Drizzle + the
// aggregator — no Next-specific imports, so route handlers and
// server components both call it.

import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import { db } from "@/db";
import { resources, sessionsBilling, users } from "@/db/schema";
import {
  aggregateReport,
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
  const sessionRows = await db
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
      useType: sessionsBilling.useType,
      note: sessionsBilling.note,
      isTeamRental: sessionsBilling.isTeamRental,
      pfaReferred: sessionsBilling.pfaReferred,
      isOnline: sessionsBilling.isOnline,
      ratePer30MinCents: sessionsBilling.ratePer30MinCents,
    })
    .from(sessionsBilling)
    .innerJoin(resources, eq(sessionsBilling.resourceId, resources.id))
    .innerJoin(users, eq(sessionsBilling.coachId, users.id))
    .where(and(...conditions))
    .orderBy(asc(sessionsBilling.startAt));

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
    useType: r.useType,
    note: r.note,
    isTeamRental: r.isTeamRental,
    pfaReferred: r.pfaReferred,
    isOnline: r.isOnline,
    ratePer30MinCents: r.ratePer30MinCents,
  }));

  return aggregateReport(aggregateInputs);
}
