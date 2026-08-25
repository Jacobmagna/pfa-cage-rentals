// ADMIN HOUR ENTRY — "have I already paid for this day?"
//
// WHY THIS EXISTS. An admin recording hours for a coach can pick ANY date, by
// design: the whole point of the feature is that work which was never logged
// still gets recorded, however long ago it happened. That freedom is also the
// feature's most expensive mistake — entering hours into a half-month Mark has
// already paid out for silently increases what the coach is owed for a period
// he considers settled, and the only place it ever surfaces is a statement
// weeks later. Nothing in the product would have told him.
//
// So before the write, we ask the database a question it can already answer:
// is there a recorded PFA→coach payout whose `covers_through` date reaches the
// day these hours are dated? If there is, the admin gets an amber DECISION
// naming that payout, and has to confirm. He is not blocked — refusing would
// close the exact hole the feature was built to close (late-arriving hours for
// work that really happened). He is told.
//
// ── WHY A SEPARATE, PURE MODULE ──────────────────────────────────────────
// Same constraint that produced `@/lib/program-stipend-field`, `@/lib/rate-input`
// and `@/lib/stipend/scope`: the module that runs the query imports `@/db` and
// is reachable only from `"use server"` code, so none of the decision logic
// there can be unit-tested. Everything that DECIDES — which payout to quote,
// and the exact words the admin reads — lives here, with no DB and no clock,
// and is provable with literals.
//
// ── 🔴 THE PREDICATE, AND WHY IT IS A DAY AND NOT A PAY PERIOD ───────────
// `coach_payments.covers_through` is a DATE stored at PFA-midnight of the day
// it names, and it means "this money settles work through the END of that
// day". The stipend guard next door reasons in half-month PAY PERIODS because
// a stipend IS a per-period amount. Hourly work is not: a log belongs to a
// DAY. Asking "does a payout cover this log's day?" quotes back to Mark
// exactly the fact he himself recorded, rather than a period boundary he never
// typed. Reasoning in periods here would also fire on a log dated Jul 20 when
// the payout only ever claimed to cover through Jul 15 — a warning whose
// stated reason is not true of the case in front of it (rule 34).
//
// A `null` covers_through is UNTAGGED money. It is deliberately not treated as
// covering anything: the payment-statement SPEC §4 is explicit that untagged
// money is counted in NO period, and inferring a coverage date from `paid_at`
// is the exact guess that column exists to prevent.

import { formatDollarsExact } from "@/lib/format-money";
import { formatPfaDateMedium } from "@/lib/timezone";

/**
 * A recorded PFA→coach payout that states which work it settles.
 *
 * Rows with a null `covers_through` never reach here — the caller drops them,
 * because untagged money makes no claim about any day (see the module note).
 */
export type RecordedPayout = {
  id: string;
  amountCents: number;
  paidAt: Date;
  /** The last day this payout claims to settle, inclusive of that whole day. */
  coversThrough: Date;
  /**
   * 🔴 BOTH statuses count, and that is deliberate. Every other money read in
   * this product pins `status = 'confirmed'`, because those reads compute what
   * is owed and a pending row is not yet money. This is not one of those reads
   * — it is a warning, and a payout Mark recorded but has not confirmed is
   * still Mark saying "I paid this." Pinning `confirmed` here would have made
   * the guard silent against the largest real payout batch in the product's
   * history (17 payouts entered in twelve minutes on 2026-08-03), which is
   * rule 30's failure mode wearing a different hat: a guard that ships inert.
   * The status is carried so the message can say which it is.
   */
  status: "pending" | "confirmed";
};

export type PaidThroughFinding = {
  /** The payout quoted to the admin — the one making the strongest claim. */
  payout: RecordedPayout;
  /** How many payouts cover this day in total, this one included. Always ≥ 1. */
  coveringCount: number;
};

/**
 * The recorded payout that already claims to cover `logDayStart`, or null when
 * none does.
 *
 * `logDayStart` must be PFA-midnight of the log's own start date, and
 * `coversThrough` is stored the same way, so the comparison is between two
 * values on the same convention. `>=` is right and the boundary is the point:
 * a payout covering through Jul 12 DOES settle work done on Jul 12, so an
 * equal comparison must fire. Two date columns on one row disagreeing about
 * wall-clock is how this codebase has produced month-boundary bugs before.
 *
 * When several payouts cover the day, the one quoted is the one reaching
 * FURTHEST past it (ties broken by the most recent payment, then by id so the
 * result is total and the message is stable across renders). That is the
 * strongest claim on the table, and `coveringCount` tells the admin it is not
 * the only one — quoting one of three as though it were the whole story is the
 * kind of half-true a person acts on.
 */
export function findPayoutCovering(
  logDayStart: Date,
  payouts: readonly RecordedPayout[],
): PaidThroughFinding | null {
  const covering = payouts.filter(
    (p) => p.coversThrough.getTime() >= logDayStart.getTime(),
  );
  if (covering.length === 0) return null;

  const strongest = covering.reduce((best, p) => {
    const byCoverage = p.coversThrough.getTime() - best.coversThrough.getTime();
    if (byCoverage !== 0) return byCoverage > 0 ? p : best;
    const byPaid = p.paidAt.getTime() - best.paidAt.getTime();
    if (byPaid !== 0) return byPaid > 0 ? p : best;
    return p.id > best.id ? p : best;
  });

  return { payout: strongest, coveringCount: covering.length };
}

/**
 * The sentence the admin reads on the amber decision, before confirming.
 *
 * WHAT IT HAS TO DO. State the fact that triggered it in the admin's own
 * vocabulary (an amount, a date he chose, a coverage date he typed), state the
 * consequence in money terms, and stop. It deliberately does NOT tell him not
 * to do it — this is very often exactly the right action, and a warning that
 * reads as a scolding is a warning people learn to click past.
 *
 * 🔴 `formatDollarsExact`, never `toFixed(2)`. This sits on the same screen as
 * the rest of the app's money, and printing "$1240.00" beside "$1,240.00" is a
 * shipped defect in this repo's history — twice.
 */
export function paidThroughMessage(
  coachLabel: string,
  logStartAt: Date,
  finding: PaidThroughFinding,
): string {
  const { payout, coveringCount } = finding;
  const amount = formatDollarsExact(payout.amountCents);
  const paidOn = formatPfaDateMedium(payout.paidAt);
  const through = formatPfaDateMedium(payout.coversThrough);
  const logDay = formatPfaDateMedium(logStartAt);

  const pending = payout.status === "pending" ? ", not yet confirmed" : "";
  const others =
    coveringCount > 1
      ? ` ${coveringCount - 1} other recorded ${
          coveringCount === 2 ? "payout covers" : "payouts cover"
        } this day as well.`
      : "";

  return (
    `${coachLabel} has already been paid through ${through} — ${amount} ` +
    `recorded on ${paidOn}${pending}. These hours are dated ${logDay}, ` +
    `inside that window, so recording them adds to what ${coachLabel} is owed ` +
    `for work you have already settled.${others}`
  );
}
