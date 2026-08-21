// payment-statement SPEC §8, §10 — THE STATEMENT'S DATA PATH.
//
// Server-side. This is the only module in `src/lib/statement/` allowed to touch
// the database; `engine.ts` stays pure so the arithmetic remains testable with
// literals, and this file stays free of arithmetic so it cannot grow a second
// opinion about money.
//
// ── ⚠️ WHY THIS FETCH IS NOT PERIOD-FILTERED ────────────────────────────────
// The engine buckets by period ITSELF, so it needs the coach's WHOLE history:
// the opening balance is "every charge before `from` minus every payment
// covering before it" and the NOT-INCLUDED block is "every charge after `to`".
// Nothing is stored (SPEC §4) — every balance on the page is a subtraction over
// the full history — so handing the engine a pre-filtered list would report an
// opening balance of $0.00 for every coach, confidently and wrongly. The period
// reaches the engine ONLY as `{fromDate, toDateExclusive}`.
//
// ── Where the money comes from ───────────────────────────────────────────────
// 🔴 NOTHING IS PRICED HERE. Cage charges come from `aggregateReport` and work
// charges from `buildWorkReport` — the shipped builders — and are handed to the
// engine's adapters, which are typed on `DetailRow` / `WorkDetailRow`
// specifically so no other route to a charge amount exists. That is what makes
// "the work statement quotes the same number as /admin/reports?tab=work" true by
// construction rather than by a test that could rot.
//
// ── Which filters apply, and which deliberately do NOT ───────────────────────
// Applied: the COACH scope. Ignored: `resourceTypes` and `programId`.
//
// That is not an oversight, it is required for the page to be honest. §7 makes
// the statement reconcile to `netCoachLedgers` — the all-time, all-resources
// figure `/admin/payments` has shown all summer — and a resource-narrowed
// statement would tie out to a number that exists nowhere else in the app while
// still calling itself "Current account balance (all time)". The Payments
// timeline already ignores both filters for the same reason, and the filter
// bar's own hints already scope them ("Cage rentals tab only" / "Work hours tab
// only"). The Statements tab says so in a line of copy as well.
//
// ── Authz (SPEC §10) ─────────────────────────────────────────────────────────
// 🔴 THE ROLL-UP IS THE WIDEST MONEY SURFACE IN THIS APP — every coach's full
// financial position, both directions, all time. It is reachable from exactly
// one place: `/admin/reports`, which opens with `requireRole("admin")` and must
// never widen to `schedule_admin`.
//
// This module is deliberately ungated, matching every other read fetch in
// `lib/reports/*` (`fetchReportData`, `fetchHourLogRows`,
// `fetchPaymentTimelineRows`): the gate lives at the page and route boundary,
// which is where a request actually arrives. The "internals take the actor,
// public wrappers gate" split SPEC §10 names is the WRITE-path convention
// (`lib/server/*-actions.ts`) and is not what a shared fetch follows here.
// ⚠️ Any NEW caller of this function must therefore carry its own admin gate.
//
// ── 🔴 No raw `sql` on this path (SPEC §12.5) ────────────────────────────────
// Every read here goes through the Drizzle query builder. A raw read bypasses
// Drizzle's timestamp parser and hands back a tz-naive string, which is the bug
// this repo has been bitten by twice — and `paidAt` / `coversThrough` are the
// two columns a month-boundary error would land on.

import { and, asc, inArray } from "drizzle-orm";
import { db } from "@/db";
import { coachPayments, users } from "@/db/schema";
import { aggregateReport } from "@/lib/reports/aggregate";
import { fetchReportSessionInputs } from "@/lib/reports/fetch";
import { fetchHourLogRows } from "@/lib/reports/hour-log-fetch";
import { buildWorkReport } from "@/lib/reports/work-report";
import { fetchStipendEarningsAllTime } from "@/lib/stipend/fetch";
import {
  chargesFromCageDetail,
  chargesFromWorkDetail,
  type StatementChargeInput,
  type StatementPaymentInput,
} from "./engine";

/**
 * The unbounded window. Deliberately sentinels rather than "no predicate":
 * reusing the shipped queries unchanged is worth more than saving two
 * comparisons, and `sessions_billing.start_at` / `hour_logs.start_at` both carry
 * an index whose leading columns the planner can still use. See the EXPLAIN note
 * in SPEC §10 — at prod volume this is ~900 rows facility-wide.
 */
const ALL_TIME_FROM = new Date("1970-01-01T00:00:00.000Z");
const ALL_TIME_TO = new Date("9999-01-01T00:00:00.000Z");

/**
 * One coach's complete history, in exactly the shape `buildStatementPair` and
 * `buildStatementRoster` accept.
 */
export type StatementCoachData = {
  coachId: string;
  coachName: string;
  coachEmail: string;
  /** ALL-TIME. */
  cageCharges: StatementChargeInput[];
  /** ALL-TIME, posted work only (the Work tab's rule, applied by its builder). */
  workCharges: StatementChargeInput[];
  /** ALL-TIME, BOTH directions. The engine routes by account. */
  payments: StatementPaymentInput[];
};

export type StatementScope = {
  /**
   * Empty = every coach with any history. Non-empty = exactly these coaches,
   * WHETHER OR NOT THEY HAVE ANY — asking for one coach and getting no document
   * would be indistinguishable from the app losing their data, and "nothing
   * owed, nothing paid" is a real and useful answer.
   */
  coachIds: string[];
};

/**
 * Reads everything the Statements tab needs, for the coaches in scope.
 *
 * Three queries in parallel — sessions, hour logs, payments — then one coach-
 * identity lookup, which has to follow because the ids it resolves can come out
 * of the first three. FOUR round trips total, and four regardless of how many
 * coaches are in scope: the roll-up is the normal case (SPEC §8.1), so anything
 * per-coach would have been N+1 by design.
 */
export async function fetchStatementCoaches(
  scope: StatementScope,
): Promise<StatementCoachData[]> {
  const { coachIds } = scope;

  const [sessionInputs, hourLogRows, paymentRows, stipendEarnings] =
    await Promise.all([
    // The SAME query the cage report and the workbook run, over an unbounded
    // window. Returns the priced session inputs, which double as the engine's
    // `CageChargeSource`s — they carry the real `startAt` / `endAt` instants,
    // whereas a `DetailRow` carries PFA-formatted strings.
    fetchReportSessionInputs({
      fromDate: ALL_TIME_FROM,
      toDateExclusive: ALL_TIME_TO,
      coachIds,
      // See the header: resource types are not applied to a statement.
      resourceTypes: [],
    }),
    // The Work tab's own fetch, NOT the schedule-note variant the tab uses for
    // display: a statement never renders a schedule note, and that variant
    // additionally reads every schedule block and block-coach row in the window
    // — over an unbounded window, three queries of pure waste.
    fetchHourLogRows({
      from: "1970-01-01",
      to: "9998-12-31",
      fromDate: ALL_TIME_FROM,
      toDateExclusive: ALL_TIME_TO,
      coachIds,
      // Mirror of resourceTypes on the work side — also not applied.
      programId: undefined,
      // Display chrome on the Work Log page; nothing on this path reads it.
      isFiltered: coachIds.length > 0,
    }),
    fetchStatementPayments(coachIds),
    // 🔴 ALL-TIME, like every other fetch on this path. The engine computes
    // opening balances from history, so it needs the whole ledger; the period
    // arrives later, as a bucketing decision, not as a query filter.
    fetchStipendEarningsAllTime(coachIds.length > 0 ? coachIds : undefined),
  ]);

  // Charges get bucketed per coach BEFORE the adapters run, because
  // `StatementChargeInput` deliberately carries no coachId — it is one coach's
  // charge by the time the engine sees it, and there is nothing to re-split on
  // afterwards.
  const cageDetailByCoach = groupBy(
    aggregateReport(sessionInputs).detail,
    (row) => row.coachId,
  );
  // Stipends are handed to the SAME builder the Work tab uses, so the work
  // statement quotes the same number as `?tab=work` by construction rather
  // than by a test that can rot — the property SPEC §10 relies on.
  const workDetailByCoach = groupBy(
    buildWorkReport(hourLogRows, stipendEarnings).detail,
    (row) => row.coachId,
  );
  const paymentsByCoach = groupBy(paymentRows, (row) => row.coachId);

  const ids =
    coachIds.length > 0
      ? // Explicit scope: honour it exactly, including a coach with no history.
        dedupe(coachIds)
      : // No scope: every coach who has ANY history. A coach with no charges and
        // no payments has an all-zero row that says nothing, and a roster of
        // those buries the coaches Mark actually has to chase.
        dedupe([
          ...cageDetailByCoach.keys(),
          ...workDetailByCoach.keys(),
          ...paymentsByCoach.keys(),
        ]);

  const identities = await fetchCoachIdentities(ids);

  const coaches: StatementCoachData[] = [];
  for (const coachId of ids) {
    const identity = identities.get(coachId);
    // A hand-edited `?coachIds=` can name an id that is not a user at all.
    // Skipping it is right: inventing a "Unknown coach" statement would be a
    // money document about nobody.
    if (!identity) continue;
    coaches.push({
      coachId,
      coachName: identity.name,
      coachEmail: identity.email,
      // Full source arrays as the lookup: the adapters index them by id and
      // THROW on an unmatched row, which is the behaviour worth keeping — a
      // charge silently missing from a statement is a wrong balance that looks
      // right.
      cageCharges: chargesFromCageDetail(
        cageDetailByCoach.get(coachId) ?? [],
        sessionInputs,
      ),
      workCharges: chargesFromWorkDetail(
        workDetailByCoach.get(coachId) ?? [],
        hourLogRows,
      ),
      payments: paymentsByCoach.get(coachId) ?? [],
    });
  }

  return coaches;
}

/**
 * Picks the single coach whose statement should render, or null for the roll-up.
 *
 * ONE coach in scope → that coach's statement; zero or many → the roster (SPEC
 * §8.1, where the many case is explicitly the normal one, not a degraded view).
 * Exported and pure so the branch the page takes is the branch the tests assert,
 * rather than a copy of it.
 */
export function singleCoachInScope(
  coachIds: string[],
  coaches: readonly StatementCoachData[],
): StatementCoachData | null {
  if (coachIds.length !== 1) return null;
  return coaches.find((c) => c.coachId === coachIds[0]) ?? null;
}

/* ── Payments ─────────────────────────────────────────────────────────────── */

type PaymentRow = StatementPaymentInput & { coachId: string };

/**
 * ALL-TIME payments for the coaches in scope, BOTH directions, and with
 * `pending` and soft-deleted rows INCLUDED.
 *
 * That last part is deliberate. `StatementPaymentInput` declares `status` and
 * `deletedAt`, and the engine is the single place that decides what they mean:
 * pending is shown but never summed, soft-deleted is dropped from every figure
 * AND from display. Filtering either here would put that decision in two files
 * that could disagree — and the failure mode of disagreeing is a payment Mark
 * recorded not appearing on a statement, which is indistinguishable from the app
 * having lost it.
 *
 * `coversThrough` is selected, obviously: it is the entire feature.
 */
async function fetchStatementPayments(
  coachIds: string[],
): Promise<PaymentRow[]> {
  const conditions = [];
  if (coachIds.length > 0) {
    conditions.push(inArray(coachPayments.coachId, coachIds));
  }

  const rows = await db
    .select({
      coachId: coachPayments.coachId,
      amountCents: coachPayments.amountCents,
      direction: coachPayments.direction,
      status: coachPayments.status,
      deletedAt: coachPayments.deletedAt,
      paidAt: coachPayments.paidAt,
      coversThrough: coachPayments.coversThrough,
      method: coachPayments.method,
      reference: coachPayments.reference,
    })
    .from(coachPayments)
    // `coach_payments_coach_paid_idx` is (coach_id, paid_at); the coach
    // predicate is served by its leading column and this ordering by its
    // second. The engine re-sorts the rows it displays, so this is for a
    // stable query plan and readable logs, not for correctness.
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(coachPayments.coachId), asc(coachPayments.paidAt));

  return rows;
}

/* ── Coach identity ───────────────────────────────────────────────────────── */

/**
 * Names and emails for the coaches in scope.
 *
 * Read from `users` rather than lifted off a `DetailRow`, for two reasons: a
 * coach can be in scope with no charges at all (so no row to lift from), and
 * `deletedAt` is deliberately NOT filtered — an archived coach who still owes
 * money belongs on the roll-up, exactly as the reports themselves keep their
 * "Former coach" rows.
 */
async function fetchCoachIdentities(
  ids: string[],
): Promise<Map<string, { name: string; email: string }>> {
  const map = new Map<string, { name: string; email: string }>();
  if (ids.length === 0) return map;

  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(inArray(users.id, ids));

  for (const row of rows) {
    // Same display fallback the report builders use, so one coach is not
    // "Alex Milone" on the Work tab and an email address on their statement.
    map.set(row.id, { name: row.name ?? row.email, email: row.email });
  }
  return map;
}

/* ── Small helpers ────────────────────────────────────────────────────────── */

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = map.get(k);
    if (list) list.push(row);
    else map.set(k, [row]);
  }
  return map;
}

function dedupe(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}
