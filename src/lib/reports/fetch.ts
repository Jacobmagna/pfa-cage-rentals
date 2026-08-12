// Shared data-fetching for /admin/reports and its download route.
// Takes the normalized filter shape, runs the SQL + aggregate
// pipeline, returns ReportData. Pure dependency on Drizzle + the
// aggregator — no Next-specific imports, so route handlers and
// server components both call it.

import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import { db } from "@/db";
import { hourLogs, resources, sessionsBilling, users } from "@/db/schema";
import type { ResourceType } from "@/lib/billing";
import {
  aggregateReport,
  type AggregateHourLogInput,
  type AggregateSessionInput,
  type ReportData,
} from "./aggregate";
import type { NormalizedFilters } from "./filters";

/**
 * The slice of `NormalizedFilters` the SESSION query reads. A
 * `NormalizedFilters` is assignable, so the reports page and the download route
 * keep passing their filter object unchanged.
 *
 * Structural rather than the whole filter type because the statement fetch
 * (`src/lib/statement/fetch.ts`) needs the same rows over a deliberately
 * unbounded window and with no resource-type narrowing — see its header for
 * why. Fabricating the `from`/`to` display STRINGS that `NormalizedFilters`
 * also carries, purely to satisfy a type, would put two date representations on
 * a money path where only the instants are ever read.
 */
export type SessionQueryScope = {
  fromDate: Date;
  toDateExclusive: Date;
  /** Empty = every coach. */
  coachIds: string[];
  /** Empty (or all three) = every resource type. CAGE SIDE ONLY. */
  resourceTypes: ResourceType[];
};

/**
 * The priced-session inputs behind the cage report — the rows `aggregateReport`
 * turns into `DetailRow`s.
 *
 * Extracted from `fetchReportData` (which still calls it, unchanged) so the
 * statement can obtain BOTH the aggregate's `DetailRow`s and the real
 * `startAt` / `endAt` instants they were built from, out of ONE query. The
 * statement engine's cage adapter needs the instants because `DetailRow`
 * carries PFA-formatted date STRINGS, and re-parsing a formatted string to
 * place a charge in a month is exactly how a month-boundary off-by-one gets in.
 */
export async function fetchReportSessionInputs(
  scope: SessionQueryScope,
): Promise<AggregateSessionInput[]> {
  const conditions = [
    gte(sessionsBilling.startAt, scope.fromDate),
    lt(sessionsBilling.startAt, scope.toDateExclusive),
  ];
  if (scope.coachIds.length > 0) {
    conditions.push(inArray(sessionsBilling.coachId, scope.coachIds));
  }
  // Skip the resource-type WHERE when all three are selected — the
  // query planner doesn't care, but keeping the SQL tight reads
  // better in logs.
  if (scope.resourceTypes.length > 0 && scope.resourceTypes.length < 3) {
    conditions.push(inArray(resources.type, scope.resourceTypes));
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
      note: sessionsBilling.note,
      ratePer30MinCents: sessionsBilling.ratePer30MinCents,
      isGroupSession: sessionsBilling.isGroupSession,
    })
    .from(sessionsBilling)
    .innerJoin(resources, eq(sessionsBilling.resourceId, resources.id))
    .innerJoin(users, eq(sessionsBilling.coachId, users.id))
    .where(and(...conditions))
    .orderBy(asc(sessionsBilling.startAt));

  return sessionRows.map((r) => ({
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
    isGroupSession: r.isGroupSession,
  }));
}

export async function fetchReportData(
  filters: NormalizedFilters,
): Promise<ReportData> {
  const aggregateInputs = await fetchReportSessionInputs(filters);

  // Work hours: same date window as sessions, plus the coach filter when
  // one is set. ALWAYS fetched.
  //
  // This used to be gated on `includeProgramHours && (resourceTypes is
  // empty or all three)` — the bug in reports-tabs SPEC §1(b). Work logs
  // are not resource bookings, so narrowing the resource-type filter to
  // (say) Cages silently dropped every work hour from the report even
  // with the "Work hours" box ticked. Both halves of that predicate are
  // gone: the scope checkboxes no longer exist (the tabs replaced them),
  // and resource types apply to the cage side ONLY (SPEC §4).
  const hourLogConditions = [
    // 1b security B: held (awaiting-approval) logs are not yet payable.
    eq(hourLogs.status, "posted"),
    gte(hourLogs.startAt, filters.fromDate),
    lt(hourLogs.startAt, filters.toDateExclusive),
  ];
  if (filters.coachIds.length > 0) {
    hourLogConditions.push(inArray(hourLogs.coachId, filters.coachIds));
  }
  // The program filter is the mirror of resourceTypes: work-side only, and
  // deliberately NOT applied to the session query above (a cage rental has
  // no program). It is applied HERE as well as on the Work tab's own fetch
  // so the two agree under every filter — otherwise a program-narrowed
  // screen would quote one work total while the workbook's Summary sheet
  // quoted another.
  if (filters.programId) {
    hourLogConditions.push(eq(hourLogs.programId, filters.programId));
  }
  const hourLogRows = await db
    .select({
      coachId: hourLogs.coachId,
      coachName: users.name,
      coachEmail: users.email,
      startAt: hourLogs.startAt,
      endAt: hourLogs.endAt,
      ratePer30MinCents: hourLogs.ratePer30MinCents,
      perSessionRateCents: hourLogs.perSessionRateCents,
    })
    .from(hourLogs)
    .innerJoin(users, eq(hourLogs.coachId, users.id))
    .where(and(...hourLogConditions))
    .orderBy(asc(hourLogs.startAt));

  const hourLogInputs: AggregateHourLogInput[] = hourLogRows.map((r) => ({
    coachId: r.coachId,
    coachName: r.coachName,
    coachEmail: r.coachEmail,
    startAt: r.startAt,
    endAt: r.endAt,
    ratePer30MinCents: r.ratePer30MinCents ?? 0,
    perSessionRateCents: r.perSessionRateCents,
  }));

  return aggregateReport(aggregateInputs, hourLogInputs);
}
