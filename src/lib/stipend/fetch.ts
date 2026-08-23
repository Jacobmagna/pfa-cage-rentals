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
import { coachStipendEarnings, users } from "@/db/schema";
import { payPeriodFor } from "@/lib/pay-period";

// Re-exported so a caller needs one import for the scope rule and the queries
// it feeds. The definition is pure and lives in `scope.ts`.
export { coachScopeFromFilters } from "./scope";

export type StipendEarningRow = {
  id: string;
  coachId: string;
  /**
   * 🔴 THE EARNING CARRIES ITS OWN COACH IDENTITY, joined here rather than
   * borrowed from whatever hour logs happen to be in scope.
   *
   * The Work tab is RANGE-filtered and stipends are included by period
   * OVERLAP, so the two sets genuinely diverge: filter Sep 10–20 and the Sep-3
   * log that earned the Sep 1–15 stipend is outside the range while the
   * stipend itself is inside it. Borrowing the name from the logs printed a
   * raw UUID in the Coach column and an empty Email cell — on a payroll screen
   * and in the workbook. `null` name falls back to email, matching every other
   * coach-display path in this codebase.
   */
  coachName: string | null;
  coachEmail: string;
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
  coachName: string | null;
  coachEmail: string;
  periodKey: string;
  periodStart: Date;
  amountCents: number;
}): StipendEarningRow {
  // Derived from `pay-period.ts` rather than stored, so the period's end can
  // never disagree with the module that defines what a period IS.
  return { ...r, periodEndExclusive: payPeriodFor(r.periodStart).toDateExclusive };
}

/**
 * The shared column list. ⚠️ Every query below INNER-joins `users`, and that
 * join cannot drop a row: `coach_id` is `.notNull().references(users.id)` with
 * `ON DELETE cascade`, so an earning whose coach is gone does not exist to be
 * joined in the first place.
 */
const SELECT = {
  id: coachStipendEarnings.id,
  coachId: coachStipendEarnings.coachId,
  coachName: users.name,
  coachEmail: users.email,
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
    .innerJoin(users, eq(coachStipendEarnings.coachId, users.id))
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
    .innerJoin(users, eq(coachStipendEarnings.coachId, users.id))
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
    .innerJoin(users, eq(coachStipendEarnings.coachId, users.id))
    .where(
      and(
        eq(coachStipendEarnings.coachId, coachId),
        isNull(coachStipendEarnings.voidedAt),
      ),
    )
    .orderBy(asc(coachStipendEarnings.periodStart));
  return rows.map(toRow);
}
