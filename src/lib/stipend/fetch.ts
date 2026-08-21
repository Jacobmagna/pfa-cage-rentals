// stipend SPEC §7.3 / §10 — THE READ PATH for earned stipends.
//
// The only module that queries `coach_stipend_earnings`. Mirrors the
// `src/lib/statement/fetch.ts` split exactly: the shaping lives in a pure
// module, this one touches the DB and nothing else.
//
// ── 🔴 VOIDED EARNINGS ARE EXCLUDED, EVERYWHERE, AT THE SOURCE ────────────
// `voided_at` is set only by a person deciding an earning should not count —
// nothing automatic ever sets it (Q3). Filtering it here rather than at each
// caller means a new read surface cannot forget: there is no way to ask this
// module for earnings and be handed voided ones.
//
// ── 🔴 "IN RANGE" MEANS OVERLAPPING, NOT CONTAINED ───────────────────────
// A stipend is owed for a whole half-month and is not pro-ratable — Mark
// rejected pro-rating explicitly. So a report filtered Aug 10 → Aug 20
// overlaps BOTH Aug 1–15 and Aug 16–31, and a coach on a stipend shows TWO
// full stipends inside a ten-day window. That is arithmetically right and it
// WILL look wrong to a reader, which is why every stipend row carries its own
// period label (SPEC §10.4).
//
// The alternative — bucketing by whether `periodStart` falls inside the range
// — silently DROPS a stipend whose period began before the filter's start,
// so a report covering the back half of a month would show a coach's hours
// and not their pay. That is the worse failure: it is invisible.
//
// ── Ungated by design ────────────────────────────────────────────────────
// Matching every other `lib/reports/*` and `lib/statement/*` fetch: the gate
// is at the page. 🔴 Any new caller must carry its own admin gate — a coach
// must never reach work PAY (SPEC §10.15).

import { and, asc, eq, inArray, isNull, lt } from "drizzle-orm";
import { db } from "@/db";
import { coachStipendEarnings } from "@/db/schema";
import { payPeriodFor } from "@/lib/pay-period";

export type StipendEarningRow = {
  id: string;
  coachId: string;
  /** "2026-09-P1" — stable, and what the UNIQUE constraint dedupes on. */
  periodKey: string;
  /** PFA-midnight on the period's first day. THE bucketing instant. */
  periodStart: Date;
  /** PFA-midnight on the day after the period's last day. Exclusive. */
  periodEndExclusive: Date;
  amountCents: number;
};

/** Shared row shape → the exported type, with the period's end derived once. */
function toRow(r: {
  id: string;
  coachId: string;
  periodKey: string;
  periodStart: Date;
  amountCents: number;
}): StipendEarningRow {
  // Derived from `pay-period.ts` rather than stored, so the period's end can
  // never disagree with the module that defines what a period IS.
  return { ...r, periodEndExclusive: payPeriodFor(r.periodStart).toDateExclusive };
}

const SELECT = {
  id: coachStipendEarnings.id,
  coachId: coachStipendEarnings.coachId,
  periodKey: coachStipendEarnings.periodKey,
  periodStart: coachStipendEarnings.periodStart,
  amountCents: coachStipendEarnings.amountCents,
};

/**
 * Every non-voided earning for the given coaches, all time.
 *
 * ⚠️ Used by `/admin/payments`, which has NO date filter — SPEC §10.2 calls
 * that the single most likely place for this feature to produce a badly wrong
 * number. It is safe only because earnings exist ONLY for periods a coach
 * actually logged covered work in, and the earliest of those is bounded by
 * when a stipend was first set (`effective_from`, Q9's Sept 1 floor). There is
 * no historical backfill beyond §15.1's, so this cannot invent back-pay for
 * half-months that predate the arrangement.
 *
 * Passing an EMPTY array returns nothing, deliberately — "no coaches in scope"
 * must not silently mean "every coach". An `undefined` coachIds means all.
 */
export async function fetchStipendEarningsAllTime(
  coachIds?: string[],
): Promise<StipendEarningRow[]> {
  if (coachIds && coachIds.length === 0) return [];
  const rows = await db
    .select(SELECT)
    .from(coachStipendEarnings)
    .where(
      and(
        isNull(coachStipendEarnings.voidedAt),
        ...(coachIds
          ? [inArray(coachStipendEarnings.coachId, coachIds)]
          : []),
      ),
    )
    .orderBy(asc(coachStipendEarnings.periodStart));
  return rows.map(toRow);
}

/**
 * Every non-voided earning whose PAY PERIOD OVERLAPS `[fromDate,
 * toDateExclusive)`. See the module note on why overlap, not containment.
 */
export async function fetchStipendEarningsInRange(args: {
  fromDate: Date;
  toDateExclusive: Date;
  coachIds?: string[];
}): Promise<StipendEarningRow[]> {
  const { fromDate, toDateExclusive, coachIds } = args;
  if (coachIds && coachIds.length === 0) return [];
  if (toDateExclusive.getTime() <= fromDate.getTime()) return [];

  // SQL narrows on the half we can express directly — a period cannot overlap
  // a range it starts at or after the end of. The other half of the overlap
  // test needs the period's END, which is derived rather than stored, so it is
  // applied in code below. At facility volume this reads tens of rows.
  const rows = await db
    .select(SELECT)
    .from(coachStipendEarnings)
    .where(
      and(
        isNull(coachStipendEarnings.voidedAt),
        lt(coachStipendEarnings.periodStart, toDateExclusive),
        ...(coachIds
          ? [inArray(coachStipendEarnings.coachId, coachIds)]
          : []),
      ),
    )
    .orderBy(asc(coachStipendEarnings.periodStart));

  return rows
    .map(toRow)
    .filter((r) => r.periodEndExclusive.getTime() > fromDate.getTime());
}

/** One coach's earnings, all time. Convenience for the coach-scoped surfaces. */
export async function fetchStipendEarningsForCoach(
  coachId: string,
): Promise<StipendEarningRow[]> {
  const rows = await db
    .select(SELECT)
    .from(coachStipendEarnings)
    .where(
      and(
        eq(coachStipendEarnings.coachId, coachId),
        isNull(coachStipendEarnings.voidedAt),
      ),
    )
    .orderBy(asc(coachStipendEarnings.periodStart));
  return rows.map(toRow);
}
