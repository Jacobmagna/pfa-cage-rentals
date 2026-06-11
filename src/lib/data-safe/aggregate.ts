// Data-Safe Snapshot — the READ-ONLY SQL aggregates that produce the
// de-identified OpFact rows pushed to Magna's central store.
//
// PRIVACY CONTRACT (enforced here, at the source):
//   - Raw rows NEVER leave. Only counts / rates / sums + salted-hash anon
//     COACH ids.
//   - NO per-athlete row, ever. Athletes (minors) appear ONLY as facility-
//     wide counts (roster size, attendance counts, enrollment counts). No
//     query in this file selects an athlete id into a dim or a subType.
//   - k-anonymity: any row partitioned by an INDIVIDUAL (anon coach) or a
//     fine-grained dim cell whose underlying count < k is SUPPRESSED.
//     Facility-wide scalar totals (e.g. bookings_count with no dims) are
//     exempt.
//
// Money + cancellation logic is REUSED, never re-derived:
//   @/lib/billing      → totalFromSnapshot, workPayForLog, slotsBetween
//   @/lib/cancellation → categorizeCancellation
//
// `computeAggregates` takes the db client as a param so the Orchestrator
// can integration-test it against a dev branch; default callers pass
// `import { db } from "@/db"`.

import { and, eq, gte, isNull, lt, sql } from "drizzle-orm";

import {
  slotsBetween,
  totalFromSnapshot,
  workPayForLog,
} from "@/lib/billing";
import { categorizeCancellation } from "@/lib/cancellation";
import { db as defaultDb } from "@/db";
import {
  athletePrograms,
  athletes,
  attendanceRecords,
  attendanceSessions,
  coachPayments,
  hourLogs,
  programs,
  resources,
  sessionCancellations,
  sessionsBilling,
} from "@/db/schema";

import { anonId, meetsK } from "./anonymize";
import type { OpFact } from "./types";

type DbClient = typeof defaultDb;

export type AggregateOpts = {
  periodStart: Date;
  periodEnd: Date;
  salt: string;
  k: number;
};

// Facility open window for utilization availability: 8:00–22:00 = 14h/day.
const FACILITY_OPEN_MINUTES_PER_DAY = 14 * 60;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ============================================================
// PURE sub-logic (unit-tested in aggregate.test.ts)
// ============================================================

export type LeadTimeBucket =
  | "same_day"
  | "1_3_days"
  | "4_7_days"
  | "over_7_days";

/**
 * Buckets a booking's lead time (startAt − createdAt) into one of four
 * coarse ranges. Negative / zero lead (booked at or after start) → same_day.
 * Boundaries by whole days: <1d same_day, 1–3d, 4–7d, >7d.
 */
export function leadTimeBucket(createdAt: Date, startAt: Date): LeadTimeBucket {
  const days = (startAt.getTime() - createdAt.getTime()) / MS_PER_DAY;
  if (days < 1) return "same_day";
  if (days <= 3) return "1_3_days";
  if (days <= 7) return "4_7_days";
  return "over_7_days";
}

/**
 * No-show rate as a 0–100 percentage: noShow / (present + noShow). Denom 0
 * (no records) → 0. Rounded to a whole percent.
 */
export function noShowRate(presentCount: number, noShowCount: number): number {
  const denom = presentCount + noShowCount;
  if (denom <= 0) return 0;
  return Math.round((100 * noShowCount) / denom);
}

/**
 * Cap-utilization as a 0–100 percentage: enrolled ÷ Σcaps (only enrollments
 * where a cap is set). Denom 0 → 0. Can exceed 100 if over-enrolled; clamp
 * is intentionally NOT applied (the raw signal is more useful).
 */
export function capUtilizationPct(
  enrolledWithCap: number,
  totalCap: number,
): number {
  if (totalCap <= 0) return 0;
  return Math.round((100 * enrolledWithCap) / totalCap);
}

/**
 * Utilization %: booked resource-minutes ÷ available resource-minutes,
 * 0–100. Available = activeResources × openMinutesPerDay × days. Denom 0
 * (no active resources or zero-length period) → 0.
 */
export function utilizationPct(
  bookedMinutes: number,
  activeResources: number,
  days: number,
  openMinutesPerDay: number = FACILITY_OPEN_MINUTES_PER_DAY,
): number {
  const available = activeResources * openMinutesPerDay * days;
  if (available <= 0) return 0;
  return Math.round((100 * bookedMinutes) / available);
}

/** Whole days (can be fractional rounded up) spanned by the period. */
export function daysInPeriod(periodStart: Date, periodEnd: Date): number {
  const ms = periodEnd.getTime() - periodStart.getTime();
  if (ms <= 0) return 0;
  return Math.ceil(ms / MS_PER_DAY);
}

/**
 * k-suppression for a set of fact rows that are EACH partitioned by an
 * individual / fine-grained dim cell. `countOf` returns the underlying
 * group size for a fact; rows whose count < k are dropped. Facility-wide
 * scalar totals should NOT be passed through this — they're k-exempt.
 */
export function suppressBelowK<T>(
  rows: T[],
  countOf: (row: T) => number,
  k: number,
): T[] {
  return rows.filter((row) => meetsK(countOf(row), k));
}

// ============================================================
// The aggregator
// ============================================================

/**
 * Computes the period's de-identified aggregates as OpFact[]. READ-ONLY:
 * every query is a SELECT. No raw row, name, email, or athlete id is ever
 * placed into a returned fact.
 */
export async function computeAggregates(
  db: DbClient,
  opts: AggregateOpts,
): Promise<OpFact[]> {
  const { periodStart, periodEnd, salt, k } = opts;
  const facts: OpFact[] = [];
  const days = daysInPeriod(periodStart, periodEnd);

  // ---- Bookings (sessions_billing, startAt in [periodStart, periodEnd)) --
  const bookingRows = await db
    .select({
      startAt: sessionsBilling.startAt,
      endAt: sessionsBilling.endAt,
      createdAt: sessionsBilling.createdAt,
      ratePer30MinCents: sessionsBilling.ratePer30MinCents,
      resourceType: resources.type,
    })
    .from(sessionsBilling)
    .innerJoin(resources, eq(sessionsBilling.resourceId, resources.id))
    .where(
      and(
        gte(sessionsBilling.startAt, periodStart),
        lt(sessionsBilling.startAt, periodEnd),
      ),
    );

  // Facility total (k-exempt scalar).
  facts.push({ metric: "bookings_count", value: bookingRows.length });

  // By resource type — suppress cells < k.
  const byResourceType = new Map<string, number>();
  // Lead-time distribution — suppress cells < k.
  const byLeadBucket = new Map<LeadTimeBucket, number>();
  // Booked resource-minutes (for utilization), total + per resource type.
  let bookedMinutes = 0;
  const bookedMinutesByType = new Map<string, number>();
  // Cage/resource revenue (facility-wide sum, k-exempt).
  let cageRevenueCents = 0;

  for (const row of bookingRows) {
    byResourceType.set(
      row.resourceType,
      (byResourceType.get(row.resourceType) ?? 0) + 1,
    );
    const bucket = leadTimeBucket(row.createdAt, row.startAt);
    byLeadBucket.set(bucket, (byLeadBucket.get(bucket) ?? 0) + 1);

    const minutes = slotsBetween(row.startAt, row.endAt) * 30;
    bookedMinutes += minutes;
    bookedMinutesByType.set(
      row.resourceType,
      (bookedMinutesByType.get(row.resourceType) ?? 0) + minutes,
    );

    cageRevenueCents += totalFromSnapshot(
      row.startAt,
      row.endAt,
      row.ratePer30MinCents,
    );
  }

  for (const [resourceTypeLabel, count] of byResourceType) {
    if (!meetsK(count, k)) continue;
    facts.push({
      metric: "bookings_count",
      value: count,
      subType: resourceTypeLabel,
      dims: { resource_type: resourceTypeLabel },
    });
  }

  for (const [bucket, count] of byLeadBucket) {
    if (!meetsK(count, k)) continue;
    facts.push({
      metric: "bookings_count",
      value: count,
      dims: { lead_time_bucket: bucket },
    });
  }

  // ---- Utilization -------------------------------------------------------
  const activeResourceRows = await db
    .select({ type: resources.type })
    .from(resources)
    .where(eq(resources.active, true));
  const activeResourceCount = activeResourceRows.length;
  const activeByType = new Map<string, number>();
  for (const r of activeResourceRows) {
    activeByType.set(r.type, (activeByType.get(r.type) ?? 0) + 1);
  }

  facts.push({
    metric: "utilization_pct",
    value: utilizationPct(bookedMinutes, activeResourceCount, days),
  });

  // Per resource type — suppress sparse types (booking count < k).
  for (const [resourceTypeLabel, count] of byResourceType) {
    if (!meetsK(count, k)) continue;
    const activeForType = activeByType.get(resourceTypeLabel) ?? 0;
    facts.push({
      metric: "utilization_pct",
      value: utilizationPct(
        bookedMinutesByType.get(resourceTypeLabel) ?? 0,
        activeForType,
        days,
      ),
      subType: resourceTypeLabel,
      dims: { resource_type: resourceTypeLabel },
    });
  }

  // ---- Attendance (facility-wide, NO athlete dims) -----------------------
  const attendanceAgg = await db
    .select({
      sessionsCount: sql<number>`count(distinct ${attendanceSessions.id})`,
      presentCount: sql<number>`count(*) filter (where ${attendanceRecords.present} = true)`,
      noShowCount: sql<number>`count(*) filter (where ${attendanceRecords.present} = false)`,
    })
    .from(attendanceSessions)
    .leftJoin(
      attendanceRecords,
      eq(attendanceRecords.sessionId, attendanceSessions.id),
    )
    .where(
      and(
        gte(attendanceSessions.sessionDate, toDateString(periodStart)),
        lt(attendanceSessions.sessionDate, toDateString(periodEnd)),
      ),
    );

  const att = attendanceAgg[0] ?? {
    sessionsCount: 0,
    presentCount: 0,
    noShowCount: 0,
  };
  const presentCount = Number(att.presentCount);
  const noShowCount = Number(att.noShowCount);
  facts.push({
    metric: "attendance_sessions_count",
    value: Number(att.sessionsCount),
  });
  facts.push({ metric: "attendance_present_count", value: presentCount });
  facts.push({ metric: "no_show_count", value: noShowCount });
  facts.push({
    metric: "no_show_rate",
    value: noShowRate(presentCount, noShowCount),
  });

  // ---- Cancellations (session_cancellations, cancelledAt in period) ------
  const cancellationRows = await db
    .select({
      startAt: sessionCancellations.startAt,
      endAt: sessionCancellations.endAt,
      cancelledAt: sessionCancellations.cancelledAt,
    })
    .from(sessionCancellations)
    .where(
      and(
        gte(sessionCancellations.cancelledAt, periodStart),
        lt(sessionCancellations.cancelledAt, periodEnd),
      ),
    );

  facts.push({
    metric: "cancellations_count",
    value: cancellationRows.length,
  });

  const byCancelCategory = new Map<string, number>();
  let lastMinuteCount = 0;
  for (const row of cancellationRows) {
    const cat = categorizeCancellation(
      row.startAt,
      row.endAt,
      row.cancelledAt,
    );
    byCancelCategory.set(cat, (byCancelCategory.get(cat) ?? 0) + 1);
    if (cat === "last_minute") lastMinuteCount += 1;
  }
  for (const [cat, count] of byCancelCategory) {
    if (!meetsK(count, k)) continue;
    facts.push({
      metric: "cancellations_count",
      value: count,
      dims: { cancel_category: cat },
    });
  }
  facts.push({
    metric: "last_minute_rate",
    value:
      cancellationRows.length > 0
        ? Math.round((100 * lastMinuteCount) / cancellationRows.length)
        : 0,
  });

  // ---- Coach activity (hour_logs, status='posted' ONLY) ------------------
  const postedLogs = await db
    .select({
      coachId: hourLogs.coachId,
      startAt: hourLogs.startAt,
      endAt: hourLogs.endAt,
      ratePer30MinCents: hourLogs.ratePer30MinCents,
      perSessionRateCents: hourLogs.perSessionRateCents,
    })
    .from(hourLogs)
    .where(
      and(
        eq(hourLogs.status, "posted"),
        gte(hourLogs.startAt, periodStart),
        lt(hourLogs.startAt, periodEnd),
      ),
    );

  type CoachAgg = { logs: number; minutes: number };
  const byCoach = new Map<string, CoachAgg>();
  let programPayCents = 0;
  for (const log of postedLogs) {
    const agg = byCoach.get(log.coachId) ?? { logs: 0, minutes: 0 };
    agg.logs += 1;
    agg.minutes += (log.endAt.getTime() - log.startAt.getTime()) / 60000;
    byCoach.set(log.coachId, agg);
    programPayCents += workPayForLog({
      perSessionRateCents: log.perSessionRateCents,
      startAt: log.startAt,
      endAt: log.endAt,
      ratePer30MinCents: log.ratePer30MinCents,
    });
  }

  // Per coach → anon id. Suppress any coach with < k logs.
  for (const [coachId, agg] of byCoach) {
    if (!meetsK(agg.logs, k)) continue;
    const anon = anonId(salt, "coach", coachId);
    facts.push({
      metric: "coach_hours_logged",
      value: Math.round((agg.minutes / 60) * 100) / 100,
      subType: anon,
      dims: { anon_coach_id: anon },
    });
    facts.push({
      metric: "coach_sessions_delivered",
      value: agg.logs,
      subType: anon,
      dims: { anon_coach_id: anon },
    });
  }
  // Facility total # distinct coaches who logged — only emit if ≥ k.
  if (meetsK(byCoach.size, k)) {
    facts.push({ metric: "coach_active_count", value: byCoach.size });
  }

  // ---- Programs / enrollment --------------------------------------------
  const activeProgramRows = await db
    .select({ id: programs.id })
    .from(programs)
    .where(eq(programs.active, true));
  const activeProgramIds = activeProgramRows.map((p) => p.id);
  facts.push({
    metric: "programs_active_count",
    value: activeProgramRows.length,
  });

  // Enrollment + cap utilization over enrollments in ACTIVE programs.
  let enrollmentCount = 0;
  let enrolledWithCap = 0;
  let totalCap = 0;
  if (activeProgramIds.length > 0) {
    const enrollmentRows = await db
      .select({ cap: athletePrograms.cap })
      .from(athletePrograms)
      .innerJoin(programs, eq(athletePrograms.programId, programs.id))
      .where(eq(programs.active, true));
    enrollmentCount = enrollmentRows.length;
    for (const e of enrollmentRows) {
      if (e.cap != null && e.cap > 0) {
        enrolledWithCap += 1;
        totalCap += e.cap;
      }
    }
  }
  facts.push({ metric: "enrollment_count", value: enrollmentCount });
  facts.push({
    metric: "cap_utilization_pct",
    value: capUtilizationPct(enrolledWithCap, totalCap),
  });

  // ---- Revenue (aggregated amounts; never payer identity) ----------------
  facts.push({ metric: "cage_revenue_cents", value: cageRevenueCents });
  facts.push({ metric: "program_pay_cents", value: programPayCents });

  // Confirmed coach payments in period (confirmedAt OR paidAt in window),
  // not deleted. Sum of amounts only.
  const paymentRows = await db
    .select({
      amountCents: coachPayments.amountCents,
      confirmedAt: coachPayments.confirmedAt,
      paidAt: coachPayments.paidAt,
    })
    .from(coachPayments)
    .where(
      and(eq(coachPayments.status, "confirmed"), isNull(coachPayments.deletedAt)),
    );
  let paymentsConfirmedCents = 0;
  for (const p of paymentRows) {
    const when = p.confirmedAt ?? p.paidAt;
    if (when && when >= periodStart && when < periodEnd) {
      paymentsConfirmedCents += p.amountCents;
    }
  }
  facts.push({
    metric: "payments_confirmed_cents",
    value: paymentsConfirmedCents,
  });

  // ---- Roster (counts only) ----------------------------------------------
  const rosterSizeAgg = await db
    .select({ n: sql<number>`count(*)` })
    .from(athletes)
    .where(
      and(isNull(athletes.archivedAt), lt(athletes.createdAt, periodEnd)),
    );
  facts.push({
    metric: "roster_size",
    value: Number(rosterSizeAgg[0]?.n ?? 0),
  });

  const joinsAgg = await db
    .select({ n: sql<number>`count(*)` })
    .from(athletes)
    .where(
      and(
        gte(athletes.createdAt, periodStart),
        lt(athletes.createdAt, periodEnd),
      ),
    );
  facts.push({ metric: "roster_joins", value: Number(joinsAgg[0]?.n ?? 0) });

  const churnAgg = await db
    .select({ n: sql<number>`count(*)` })
    .from(athletes)
    .where(
      and(
        sql`${athletes.archivedAt} is not null`,
        gte(athletes.archivedAt, periodStart),
        lt(athletes.archivedAt, periodEnd),
      ),
    );
  facts.push({ metric: "roster_churn", value: Number(churnAgg[0]?.n ?? 0) });

  return facts;
}

/** UTC YYYY-MM-DD for comparing against `date`-mode columns (sessionDate). */
function toDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}
