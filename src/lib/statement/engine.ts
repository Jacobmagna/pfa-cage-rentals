// payment-statement SPEC §5 — THE STATEMENT ENGINE.
//
// Pure shaping. No DB, no React, no I/O, no `Date.now()` — every figure is
// deterministic given its inputs, so the arithmetic can be covered with
// literals and without mocks. Phase C fetches rows and maps them in; this file
// never learns where they came from.
//
// ── ONE engine, parameterised by ACCOUNT (SPEC §5.0, §5.4) ───────────────────
// There is no `buildCageStatement` and no `buildWorkStatement`, and there must
// never be. The cage/work difference is entirely DATA IN (which charges, which
// payment `direction`) plus LABELS OUT. The four figures, the predicates, the
// tie-out identity and the NOT-INCLUDED block are byte-identical between the
// two — so a second implementation would be two copies of the same money math
// waiting to disagree with each other, which is the drift this codebase has
// been bitten by repeatedly (SPEC §3).
//
// ── This module COMPUTES NO MONEY, it only ARRANGES it (SPEC §3, §10) ────────
// 🔴 There is deliberately no charge-summing formula, no work-pay formula and
// no second netting helper in here. Every one of those already exists in
// production and this feature is not allowed to grow a second copy:
//
//   · per-session cage charge  → `totalFromSnapshot`  (via `aggregateReport`)
//   · per-log work pay         → `workPayForLog`      (via `buildWorkReport`)
//   · posted-only work rule    → `buildWorkReport`     (REPORTED_STATUSES)
//   · payments netted by direction → `netCoachLedgers` (`payment-ledger.ts`)
//
// So `StatementChargeInput.amountCents` arrives ALREADY PRICED, and the two
// adapters at the bottom of this file are typed on `DetailRow` /
// `WorkDetailRow` — types only the existing builders can produce. That is not
// stylistic: it is what makes "the work statement quotes the same number as
// /admin/reports?tab=work" true by CONSTRUCTION rather than by a test that
// could rot. A test asserts it too, but the type is the guarantee.
//
// `netCoachLedgers` is ALL-TIME and positional-arg, and is called here EXACTLY
// as it is everywhere else — it is NOT extended to take a date range (SPEC
// §10). It produces one thing for us: the `currentBalanceCents` that the
// statement's own ranged subtraction must reconcile to (§7). The ranged figures
// are this file's arithmetic; the all-time figure is the existing helper's.
//
// ── The load-bearing asymmetry (SPEC §5.1) ──────────────────────────────────
// 🔴 CHARGES ARE BUCKETED BY WHEN THEY HAPPENED. PAYMENTS BY WHAT THEY COVER.
// `paidAt` appears on the statement as information and is NEVER used to place a
// payment in a period. That one sentence is the whole feature: Alex Milone owed
// $660 for July and Zelled it on Aug 7, and bucketing by `paidAt` reports July
// as $660 outstanding AND August as a phantom $660 credit — two confident,
// authoritative-looking wrong numbers.
//
// ── Signs (SPEC §5.2) ────────────────────────────────────────────────────────
// Cents stay SIGNED here (the card formats, and applies `Math.abs` + a "credit"
// badge). A positive closing balance means the account's STATED direction still
// holds; a negative one means it flipped, so `directionLabel` flips with it —
// otherwise the card's header would print "Alex Milone owes PFA · $40.00" for
// money PFA actually owes him, which is a bare negative wearing a sentence.

import { formatDollarsExact } from "@/lib/format-money";
import {
  COVERED_BY_STIPEND_LABEL,
  STIPEND_FLAT_RATE_LABEL,
  STIPEND_LINE_LABEL,
  WORK_PAY_CAVEAT,
  WORK_SCOPE_NOTE_TEXT,
} from "@/lib/stipend/labels";
import {
  netCoachLedgers,
  type LedgerPayment,
} from "@/lib/payment-ledger";
import type { DetailRow } from "@/lib/reports/aggregate";
import { cageRateLabel } from "@/lib/reports/rate-display";
import type { WorkDetailRow } from "@/lib/reports/work-report";
import type { PaymentDirection } from "@/lib/schemas/payment";
import { PFA_TIMEZONE, formatPfaTime12h, formatPfaWeekday, pfaParts } from "@/lib/timezone";
import type {
  Statement,
  StatementAccount,
  StatementChargeLine,
  StatementChargeRow,
  StatementPair,
  StatementPaymentRow,
  StatementRosterEntry,
} from "./types";

/* ── Inputs ──────────────────────────────────────────────────────────────── */

/**
 * The inclusive PFA-day period, as the two half-open instants
 * `normalizeFilters` already produces. A `NormalizedFilters` is assignable.
 *
 * Deliberately does NOT also carry the `from` / `to` date STRINGS. Every label
 * on the statement is derived from these two instants, so carrying the strings
 * too would be a second source of truth for the same boundary — and a caller
 * that passed a `from` string disagreeing with `fromDate` would render a period
 * header that contradicted the arithmetic beneath it.
 */
export type StatementPeriod = {
  /** UTC instant at PFA-midnight on the first day of the period. */
  fromDate: Date;
  /** UTC instant at PFA-midnight on the day AFTER the last day of the period. */
  toDateExclusive: Date;
};

/**
 * One already-priced charge.
 *
 * 🔴 `amountCents` is an INPUT, never computed here. It comes from
 * `totalFromSnapshot` (cage) or `workPayForLog` (work) by way of the existing
 * report builders — see the adapters at the bottom of this file. The engine
 * sums; it does not price.
 */
export type StatementChargeInput = {
  /** When it HAPPENED. The only thing that places this charge in a period. */
  startAt: Date;
  endAt: Date;
  /**
   * The CHARGES-THIS-PERIOD summary bucket: a resource type on the cage
   * account ("Cage" / "Bullpen" / "Weight room" / "Group weight room", exactly
   * the breakout `SummaryRow` already carries) or a program name on the work
   * account. Never one lump — the rates differ per line.
   */
  lineLabel: string;
  /** The detail-row description: "Cage 2", "HS Summer Program-Throwing". */
  description: string;
  /** Pre-formatted: "$44.00/hr" · "$100.00/session" · "No rate". */
  rateLabel: string;
  /**
   * Billed 30-minute slots (cage), or null on the work account, which has no
   * slot model. Drives whether the summary line reads "16 slots · 8.0 h" or
   * just "24.0 h".
   */
  slots: number | null;
  /**
   * Exact hours for display. A 45-min work log is 0.75.
   *
   * 🔴 `null` means THIS CHARGE HAS NO HOURS CONCEPT — a stipend is owed for a
   * period, not for time. It is deliberately not `0`: a rendered "0.0 h" beside
   * a $2,500 line reads as "worked nothing, paid anyway", which is the same
   * class of misreading as "$0.00/hr" for an unset rate. A summary line whose
   * charges are all hour-less renders an em dash instead of a duration.
   */
  hours: number | null;
  /**
   * 🔴 WHEN SET, THIS CHARGE IS BUCKETED BY OVERLAP OF
   * `[startAt, spansToExclusive)` RATHER THAN BY THE INSTANT `startAt`.
   *
   * Only a stipend sets it, and only because a stipend genuinely occupies a
   * SPAN — it is owed for a whole half-month, not incurred at a moment.
   *
   * Without this the Work tab and the Statements tab answered the same
   * question differently. `fetchStipendEarningsInRange` includes a stipend
   * whose period OVERLAPS the filter; `computeStatement` bucketed by
   * `startAt`, i.e. containment. Filter Sep 10–20 with one Sep 1–15 stipend
   * and the Work tab showed $2,500 in range while the statement showed $0 in
   * the period, $2,500 in the opening balance, and NO stipend row at all — so
   * a coach whose only pay in the range was the stipend got a statement with
   * no charges on it and nothing explaining why. Two answers, adjacent tabs,
   * one filter bar, which is the exact failure the roster-vs-statement
   * incident is remembered for.
   *
   * ⚠️ Opt-in on purpose. Bucketing EVERY charge by `[startAt, endAt)` would
   * silently change shipped behaviour for an hour log or cage session that
   * straddles a period boundary — those are placed by `startAt` by design, and
   * that rule is documented in the pay-period spec.
   */
  spansToExclusive?: Date | null;
  /** ALREADY COMPUTED by the shared money helpers. Never recomputed here. */
  amountCents: number;
};

/**
 * One payment row as stored. Both directions may be passed in for a coach —
 * `buildStatement` routes by the account's direction, exactly as
 * `netCoachLedgers` does, and never writes a second router.
 */
export type StatementPaymentInput = {
  amountCents: number;
  direction: PaymentDirection;
  status: "pending" | "confirmed";
  /** Non-null = soft-deleted. Excluded from every figure AND from display. */
  deletedAt: Date | null;
  /** When the money ARRIVED. Display only — it never places a payment. */
  paidAt: Date;
  /**
   * The period this money settles, or null for "no period stated". NULL IS
   * LOAD-BEARING: unplaceable money is evidence about no particular month, so
   * it lands in `unappliedCents` and in NO period's opening, payments or
   * closing figure (SPEC §4, §7).
   */
  coversThrough: Date | null;
  /** Raw enum value ("zelle"); capitalized for display. */
  method: string;
  reference: string | null;
};

export type BuildStatementInput = {
  account: StatementAccount;
  coachName: string;
  period: StatementPeriod;
  /**
   * ⚠️ ALL-TIME charges for this coach on THIS account — not just the period's.
   * The opening balance is "everything before `from`" and the NOT-INCLUDED
   * block is "everything after `to`", so a pre-filtered list would silently
   * report an opening balance of $0 for every coach (SPEC §4: nothing is
   * stored, every balance is a subtraction over the full history).
   */
  charges: readonly StatementChargeInput[];
  /** ⚠️ ALL-TIME payments for this coach, EITHER direction. Routed by account. */
  payments: readonly StatementPaymentInput[];
};

export type BuildStatementPairInput = {
  coachName: string;
  coachEmail: string;
  period: StatementPeriod;
  /** ALL-TIME. See the warning on `BuildStatementInput.charges`. */
  cageCharges: readonly StatementChargeInput[];
  /** ALL-TIME. Posted work only — see `chargesFromWorkDetail`. */
  workCharges: readonly StatementChargeInput[];
  /** ALL-TIME, both directions. */
  payments: readonly StatementPaymentInput[];
};

/* ── Direction routing (SPEC §10) ────────────────────────────────────────── */

/**
 * The only place the account↔direction mapping is written in this feature.
 * `netCoachLedgers` routes payments the same way for the all-time figure; this
 * is the ranged half of the same rule, not a second router with its own idea.
 */
const DIRECTION_FOR_ACCOUNT: Record<StatementAccount, PaymentDirection> = {
  cage: "coach_to_pfa",
  work: "pfa_to_coach",
};

/**
 * SPEC §11 — MANDATORY on the work account, on screen and in print. Verbatim
 * from the Work hours tab's `PayoutLedgerCaveat`
 * (`admin/reports/_components/work-preview.tsx`) rather than paraphrased: two
 * surfaces quoting the same caution in different words is how one of them ends
 * up sounding optional.
 *
 * The app has essentially no payout ledger — Mark pays coaches outside the
 * system — so a "PFA owes Alex $660" figure is GROSS of cash already handed
 * over. Unlike a screen, a statement is a document that can be handed to the
 * person it is about, and overstating what a coach is owed in writing is the
 * most expensive mistake available in this feature. Null on the cage account,
 * whose charges AND payments both live in the app.
 */
// 🔴 Imported, not restated. This sentence lives in THREE places and the
// rule that they match used to be a comment; it is now a constant.
const WORK_CAVEAT = WORK_PAY_CAVEAT;

/**
 * SPEC §5.0/§11 — the work account counts POSTED work only, matching the
 * shipped Work hours tab (a rejected log is work an admin decided not to pay;
 * a held log is not yet approved, therefore not yet payable). Stated in the
 * document because two payroll surfaces disagreeing about one coach and one
 * period is worse than either figure alone, and an unexplained gap is what
 * makes a reader distrust the rest of the page.
 */
const WORK_SCOPE_NOTE = WORK_SCOPE_NOTE_TEXT;

/** The one em dash this document uses for "there is nothing to quote". */
const EM_DASH = "\u2014";

/* ── The engine ──────────────────────────────────────────────────────────── */

/**
 * Build ONE account's statement.
 *
 * `currentBalanceCents` comes from `netCoachLedgers` — the same all-time
 * figure `/admin/payments` has shown all summer. The other account's owed total
 * is passed as 0 because this call exists to net THIS account and the two
 * ledgers never cross (SPEC §11); only this account's balance is read back.
 */
export function buildStatement(input: BuildStatementInput): Statement {
  const owedAllTimeCents = sumCents(input.charges);
  const ledgers = netCoachLedgers(
    input.account === "cage" ? owedAllTimeCents : 0,
    input.account === "work" ? owedAllTimeCents : 0,
    ledgerPayments(input.payments),
  );
  return computeStatement({
    account: input.account,
    coachName: input.coachName,
    period: input.period,
    charges: input.charges,
    payments: input.payments,
    currentBalanceCents:
      input.account === "cage"
        ? ledgers.cageBalanceCents
        : ledgers.workBalanceCents,
  });
}

/**
 * Build BOTH of a coach's accounts for one period.
 *
 * 🔴 There is no combined total here and there must never be. The two ledgers
 * run in opposite directions and this codebase forbids summing them in three
 * separate places; `StatementPair` has no field to put one in, which is the
 * point of that shape.
 *
 * `netCoachLedgers` is called ONCE with both real owed totals — so the two
 * `currentBalanceCents` values on the pair are the same two numbers
 * `/admin/payments` renders, from the same function, and cannot drift from it.
 */
export function buildStatementPair(
  input: BuildStatementPairInput,
): StatementPair {
  const ledgers = netCoachLedgers(
    sumCents(input.cageCharges),
    sumCents(input.workCharges),
    ledgerPayments(input.payments),
  );

  const cage = computeStatement({
    account: "cage",
    coachName: input.coachName,
    period: input.period,
    charges: input.cageCharges,
    payments: input.payments,
    currentBalanceCents: ledgers.cageBalanceCents,
  });
  const work = computeStatement({
    account: "work",
    coachName: input.coachName,
    period: input.period,
    charges: input.workCharges,
    payments: input.payments,
    currentBalanceCents: ledgers.workBalanceCents,
  });

  return {
    coachName: input.coachName,
    coachEmail: input.coachEmail,
    periodLabel: statementPeriodLabel(input.period),
    periodEndShort: pfaMonthDay(lastInstantOfPeriod(input.period)),
    cage,
    work,
  };
}

function computeStatement(args: {
  account: StatementAccount;
  coachName: string;
  period: StatementPeriod;
  charges: readonly StatementChargeInput[];
  payments: readonly StatementPaymentInput[];
  currentBalanceCents: number;
}): Statement {
  const { account, coachName, period } = args;
  const from = period.fromDate.getTime();
  const toExclusive = period.toDateExclusive.getTime();

  /* Charges — bucketed by WHEN THEY HAPPENED (SPEC §5.1). */
  let chargesBeforeCents = 0;
  let chargesCents = 0;
  let chargesAfterCents = 0;
  const inPeriod: StatementChargeInput[] = [];
  for (const charge of args.charges) {
    const at = charge.startAt.getTime();
    // A SPAN charge (a stipend) is placed by overlap; an instant charge (every
    // log and session) is placed by its start, exactly as before. The three
    // buckets stay a complete partition either way — a span is "before" only
    // when it ENDS at or before the period opens — so no charge can be counted
    // twice or dropped, and the closing balance is unchanged by the choice.
    const spanEnd = charge.spansToExclusive?.getTime() ?? null;
    const endsBefore = spanEnd == null ? at < from : spanEnd <= from;
    const startsAfter = at >= toExclusive;
    if (endsBefore) {
      chargesBeforeCents += charge.amountCents;
    } else if (!startsAfter) {
      chargesCents += charge.amountCents;
      inPeriod.push(charge);
    } else {
      chargesAfterCents += charge.amountCents;
    }
  }

  /* Payments — bucketed by WHAT THEY COVER. `paidAt` is never consulted. */
  const direction = DIRECTION_FOR_ACCOUNT[account];
  let paymentsBeforeCents = 0;
  let paymentsCents = 0;
  let paymentsCoveringAfterCents = 0;
  let unappliedCents = 0;
  const paymentRows: StatementPaymentRow[] = [];
  const rowSort: { paidAt: number; row: StatementPaymentRow }[] = [];

  for (const payment of args.payments) {
    // Soft-deleted money is gone from every figure AND from display: a
    // deleted row on a statement is a claim we have withdrawn.
    if (payment.deletedAt != null) continue;
    // The other account's money. A payment tagged with the wrong direction is
    // a data-entry matter Mark self-serves in the payment dialog — the
    // statement must never infer around it (SPEC §10).
    if (payment.direction !== direction) continue;

    // Pending is SHOWN but never summed. `netCoachLedgers` already refuses to
    // let pending move a balance and the statement must not disagree with it;
    // silently dropping it would be a support call, because Mark recording a
    // payment and not seeing it is indistinguishable from the app losing it.
    const confirmed = payment.status === "confirmed";

    if (payment.coversThrough == null) {
      // No period stated → counted in NO period. Not opening, not payments,
      // not closing, and NOT a settled row on any period's statement. A
      // CONFIRMED one surfaces in the NOT-INCLUDED block's "Payments with no
      // period stated" line, which is what makes Mark go tag it.
      if (confirmed) {
        unappliedCents += payment.amountCents;
        continue;
      }
      // 🔴 A PENDING UNTAGGED PAYMENT USED TO VANISH ENTIRELY. It is neither
      // confirmed (so it cannot be unapplied money — pending moves nothing) nor
      // dated (so it belongs to no period), and the original `continue` left it
      // in no figure and no row on any statement, while /admin/payments showed
      // it plainly. SPEC §5.3's reason for showing pending applies verbatim:
      // "Mark recording a payment and not seeing it on the statement is a
      // support call" — and this is the version of that where he has BOTH
      // mistakes to fix (confirm it, and date it), so hiding it is the worst
      // possible response.
      //
      // It becomes a row with `coversThrough: null` and `pending: true`, which
      // the card renders in its pending block explicitly labelled "no period
      // stated". It reaches NO figure: `paymentsCents`, `openingCents`,
      // `unappliedCents` and every NOT-INCLUDED total are all untouched, so both
      // SPEC §5.2 and §7 identities are unaffected — the row is testimony, not
      // arithmetic.
      rowSort.push({
        paidAt: payment.paidAt.getTime(),
        row: {
          paidOn: pfaMonthDayPadded(payment.paidAt),
          method: methodLabel(payment.method),
          reference: payment.reference,
          coversThrough: null,
          amountCents: payment.amountCents,
          pending: true,
        },
      });
      continue;
    }

    const covers = payment.coversThrough.getTime();
    // Half-open, exactly as the charge predicate: `covers === toExclusive`
    // belongs to the NEXT period. This boundary is the whole failure mode
    // (SPEC §12.6) — Alex's case IS a month boundary.
    const coversPeriod = covers >= from && covers < toExclusive;

    if (confirmed) {
      if (covers < from) {
        paymentsBeforeCents += payment.amountCents;
      } else if (coversPeriod) {
        paymentsCents += payment.amountCents;
      } else {
        paymentsCoveringAfterCents += payment.amountCents;
      }
    }

    if (coversPeriod) {
      rowSort.push({
        paidAt: payment.paidAt.getTime(),
        row: {
          paidOn: pfaMonthDayPadded(payment.paidAt),
          method: methodLabel(payment.method),
          reference: payment.reference,
          coversThrough: pfaMonthDayPadded(payment.coversThrough),
          amountCents: payment.amountCents,
          pending: !confirmed,
        },
      });
    }
  }
  rowSort.sort((a, b) => a.paidAt - b.paidAt || a.row.amountCents - b.row.amountCents);
  for (const entry of rowSort) paymentRows.push(entry.row);

  /* The four figures (SPEC §5.2). */
  const openingCents = chargesBeforeCents - paymentsBeforeCents;
  const closingCents = openingCents + chargesCents - paymentsCents;

  return {
    account,
    directionLabel: directionLabel(account, coachName, closingCents),
    openingLabel: `Previous balance (as of ${pfaMonthDay(
      new Date(period.fromDate.getTime() - 1),
    )})`,
    closingLabel: `Statement balance as of ${pfaMonthDay(
      lastInstantOfPeriod(period),
    )}`,

    openingCents,
    chargesCents,
    paymentsCents,
    closingCents,

    chargeLines: buildChargeLines(inPeriod),
    chargeRows: buildChargeRows(inPeriod),
    paymentRows,

    unappliedCents,
    chargesAfterCents,
    paymentsCoveringAfterCents,
    currentBalanceCents: args.currentBalanceCents,

    caveat: account === "work" ? WORK_CAVEAT : null,
    scopeNote: account === "work" ? WORK_SCOPE_NOTE : null,
  };
}

/* ── The roll-up (SPEC §8.1) ─────────────────────────────────────────────── */

// `StatementRosterEntry` — the row shape — lives in `./types`, the module that
// already holds the engine↔view contract. It cannot live here AND in the
// component that renders it: this file is pure and must never import a React
// component, and the component must not own the engine's output shape. It was
// declared in both places during the mock; Phase C collapsed it to one.

export type BuildStatementRosterInput = {
  period: StatementPeriod;
  coaches: readonly {
    coachId: string;
    coachName: string;
    coachEmail: string;
    /** ALL-TIME. */
    cageCharges: readonly StatementChargeInput[];
    /** ALL-TIME, posted only. */
    workCharges: readonly StatementChargeInput[];
    /** ALL-TIME, both directions. */
    payments: readonly StatementPaymentInput[];
  }[];
};

/**
 * The zero-or-many-coaches case, which is the USUAL one because Mark arrives
 * from the Reports filter bar. Not a degraded statement view — it is the
 * ranged-AND-netted "who owes me / who do I owe" answer no screen in this app
 * gives today (SPEC §1b, §8.1).
 *
 * Each row is built by running the SAME `buildStatementPair` the row's own
 * statement will render, so a roster figure can never disagree with the
 * document it links to. Sorted by coach name, matching `aggregateReport` and
 * `buildWorkReport`.
 */
export function buildStatementRoster(
  input: BuildStatementRosterInput,
): StatementRosterEntry[] {
  return input.coaches
    .map((coach) => {
      const pair = buildStatementPair({
        coachName: coach.coachName,
        coachEmail: coach.coachEmail,
        period: input.period,
        cageCharges: coach.cageCharges,
        workCharges: coach.workCharges,
        payments: coach.payments,
      });
      return {
        coachId: coach.coachId,
        coachName: coach.coachName,
        cageBalanceCents: pair.cage.closingCents,
        workBalanceCents: pair.work.closingCents,
        unappliedCents: pair.cage.unappliedCents + pair.work.unappliedCents,
      };
    })
    .sort((a, b) => a.coachName.localeCompare(b.coachName));
}

/* ── Adapters: the existing report builders → engine charge inputs ───────── */

/**
 * The fields the cage adapter needs off an `AggregateSessionInput` to place a
 * charge in time. `DetailRow` carries PFA-formatted date/time STRINGS, not
 * instants, and reconstructing an instant by re-parsing a formatted string on a
 * money path is exactly the kind of cleverness that produces a month-boundary
 * off-by-one. So the real `Date`s come from the source rows.
 */
export type CageChargeSource = {
  sessionId: string;
  startAt: Date;
  endAt: Date;
};

export type WorkChargeSource = {
  id: string;
  startAt: Date;
  endAt: Date;
};

const CAGE_LINE_LABELS = {
  cage: "Cage",
  bullpen: "Bullpen",
  weight_room: "Weight room",
  group_weight_room: "Group weight room",
} as const;

/** Canonical CHARGES order for the cage account — the same breakout, in the
 *  same order, that `SummaryRow` and the Reports cage tab already use. */
const CAGE_LINE_ORDER: readonly string[] = [
  CAGE_LINE_LABELS.cage,
  CAGE_LINE_LABELS.bullpen,
  CAGE_LINE_LABELS.weight_room,
  CAGE_LINE_LABELS.group_weight_room,
];

/**
 * `aggregateReport(...).detail` → engine charge inputs, for the CAGE account.
 *
 * Takes the priced `DetailRow`s and the session inputs they were built from,
 * matched by `sessionId`. Typed on `DetailRow` on purpose: the only way to
 * obtain one is through `aggregateReport`, so the statement's cage charges are
 * `totalFromSnapshot` output by construction and there is no route by which a
 * caller could hand-roll a price.
 *
 * Throws on an unmatched row rather than dropping it. A charge silently missing
 * from a statement is a wrong balance that looks right.
 */
export function chargesFromCageDetail(
  detail: readonly DetailRow[],
  sources: readonly CageChargeSource[],
): StatementChargeInput[] {
  const byId = new Map(sources.map((s) => [s.sessionId, s]));
  return detail.map((row) => {
    const source = byId.get(row.sessionId);
    if (!source) {
      throw new Error(
        `chargesFromCageDetail: no source session for ${row.sessionId}`,
      );
    }
    const label = row.isGroupSession
      ? CAGE_LINE_LABELS.group_weight_room
      : CAGE_LINE_LABELS[row.resourceType];
    return {
      startAt: source.startAt,
      endAt: source.endAt,
      lineLabel: label,
      // Group bookings say so on the row — the rate differs, so a bare
      // "Weight Room" beside a group rate reads as a pricing error.
      description: row.isGroupSession
        ? `${row.resourceName} (Group)`
        : row.resourceName,
      // 🔴 `cageRateLabel`, NOT a local formatter. This line used to read
      // `${formatDollarsExact(row.ratePerSlotCents * 2)}/hr` for EVERY resource
      // type, while the shipped Reports screen's `RateCell` quotes cage and
      // bullpen "/30 min" and only the weight room "/hr" — so the same session's
      // rate read `$22.00 /30 min` on /admin/reports and `$44.00/hr` on the
      // printed statement. The convention now lives in exactly one module and
      // both surfaces call it (`lib/reports/rate-display.ts`).
      //
      // A $0 rate still prints a figure: `ratePerSlotCents` is NOT NULL on
      // `sessions_billing`, so zero is a deliberate comp. "No rate" is reserved
      // for the work account's nullable snapshots, below.
      rateLabel: cageRateLabel(row.ratePerSlotCents, row.resourceType),
      slots: row.slots,
      // BILLED hours, from the slot count — not wall-clock duration. A
      // 9:14–10:01 booking bills 3 slots, and printing "0.8 h" beside a
      // 1.5-slot-hours charge would make the line visibly fail to foot.
      hours: row.slots / 2,
      amountCents: row.totalCents,
    };
  });
}

/**
 * `buildWorkReport(...).detail` → engine charge inputs, for the WORK account.
 *
 * 🔴 Typed on `WorkDetailRow`, which ONLY `buildWorkReport` produces. That is
 * how the POSTED-ONLY rule and `workPayForLog` are applied exactly once, in
 * the builder that already ships them (`work-report.ts` — `REPORTED_STATUSES`),
 * instead of being re-stated here where it could drift. It is also why the work
 * statement is guaranteed to quote the same total as
 * `/admin/reports?tab=work` for the same coach and period, rather than merely
 * tested to (SPEC §10).
 */
export function chargesFromWorkDetail(
  detail: readonly WorkDetailRow[],
  sources: readonly WorkChargeSource[],
): StatementChargeInput[] {
  const byId = new Map(sources.map((s) => [s.id, s]));
  return detail.map((row) => {
    // 🔴 A stipend row has NO source hour log — it is owed to a person for a
    // period, not for a logged session. It is mapped here rather than filtered
    // out, because the work statement's total comes from these charges and a
    // stipend that is paid but not shown is the "rows do not add up" failure
    // this whole module is built to avoid.
    if (row.kind === "stipend") {
      if (!row.periodStart || !row.periodEndExclusive || !row.periodLabel) {
        // Unreachable through `buildWorkReport`, which always sets all three
        // together. Loud rather than silently mis-bucketing to the epoch.
        throw new Error(
          `chargesFromWorkDetail: stipend row ${row.id} is missing its period`,
        );
      }
      return {
        startAt: row.periodStart,
        endAt: row.periodEndExclusive,
        // 🔴 The stipend occupies a SPAN, so it is bucketed by overlap — the
        // same rule `fetchStipendEarningsInRange` applies for the Work tab.
        // This is what stops the two surfaces quoting different money for the
        // same filter; see the note on `StatementChargeInput.spansToExclusive`.
        spansToExclusive: row.periodEndExclusive,
        // Its OWN summary line, never merged into a program's.
        lineLabel: STIPEND_LINE_LABEL,
        // 🔴 The period label is IN the row: a filtered range can overlap two
        // periods and show two stipends, and the reader must see why.
        description: `${STIPEND_LINE_LABEL} — ${row.periodLabel}`,
        rateLabel: STIPEND_FLAT_RATE_LABEL,
        slots: null,
        // Not 0 — see the note on StatementChargeInput.hours.
        hours: null,
        amountCents: row.payCents,
      };
    }
    const source = byId.get(row.id);
    if (!source) {
      throw new Error(`chargesFromWorkDetail: no source hour log for ${row.id}`);
    }
    return {
      startAt: source.startAt,
      endAt: source.endAt,
      lineLabel: row.programName,
      description: row.programName,
      rateLabel: workRateLabel(row),
      // No slot model on the work side: program pay is per-hour × EXACT
      // duration (15-min granular), so slots would be a fiction.
      slots: null,
      hours: row.hours,
      amountCents: row.payCents,
    };
  });
}

/**
 * "$100.00/session" · "$30.00/hr" · "Covered by stipend" · "No rate".
 *
 * Never "$0.00/hr" for a MISSING rate: both work snapshots are nullable (a
 * pre-rate log carries neither and pays $0), and a rendered zero reads as a
 * deliberate decision to pay nothing rather than as an unset rate.
 *
 * 🔴 The COVERED branch comes FIRST, before the rate snapshots, because a
 * covered log carries no snapshot either — it would otherwise fall through to
 * "No rate" beside four real hours, which reads as a misconfiguration rather
 * than the decision it is (SPEC §10.3).
 *
 * ⚠️ THIS ONLY EVER SEES A **LOG** ROW, and the parameter type says so rather
 * than leaving it to a comment. `chargesFromWorkDetail` early-returns for a
 * stipend row long before it gets here, so a `kind === "stipend"` branch in
 * this function is DEAD CODE — an earlier version had one, and a mutation that
 * deleted it broke nothing, which is how it was found. A guard that cannot run
 * is worse than no guard: the next reader trusts it.
 */
function workRateLabel(
  row: Pick<
    WorkDetailRow,
    "stipendCovered" | "perSessionRateCents" | "ratePer30MinCents"
  >,
): string {
  if (row.stipendCovered) return COVERED_BY_STIPEND_LABEL;
  if (row.perSessionRateCents != null) {
    return `${formatDollarsExact(row.perSessionRateCents)}/session`;
  }
  if (row.ratePer30MinCents != null) {
    return `${formatDollarsExact(row.ratePer30MinCents * 2)}/hr`;
  }
  return "No rate";
}

/* ── Rows and lines ──────────────────────────────────────────────────────── */

function buildChargeLines(
  charges: readonly StatementChargeInput[],
): StatementChargeLine[] {
  // `hours` accumulates only real durations; `hasHours` records whether ANY
  // charge in the bucket had a duration at all. Without that flag a stipend
  // bucket would be indistinguishable from a genuine 0.0-hour one.
  type Bucket = {
    label: string;
    slots: number | null;
    hours: number;
    hasHours: boolean;
    cents: number;
  };
  const buckets = new Map<string, Bucket>();
  for (const charge of charges) {
    let bucket = buckets.get(charge.lineLabel);
    if (!bucket) {
      bucket = {
        label: charge.lineLabel,
        slots: 0,
        hours: 0,
        hasHours: false,
        cents: 0,
      };
      buckets.set(charge.lineLabel, bucket);
    }
    // A single slotless charge makes the whole line slotless: half a slot
    // count is worse than none, because it invites the reader to divide it
    // into the amount and get a rate that was never charged.
    bucket.slots =
      charge.slots == null || bucket.slots == null
        ? null
        : bucket.slots + charge.slots;
    // Same reasoning as `slots` above, mirrored: an hour-less charge does not
    // contribute a zero, it records that this line has no duration to quote.
    if (charge.hours != null) {
      bucket.hours += charge.hours;
      bucket.hasHours = true;
    }
    bucket.cents += charge.amountCents;
  }

  // A line only exists when there was activity in it, so zero-activity lines
  // are suppressed by construction (SPEC §5.3) — but a bucket whose charges
  // total $0 is KEPT: a $0-rate booking is real activity, and inventing its
  // absence is the same failure as inventing a zero.
  return Array.from(buckets.values())
    .sort(byCanonicalThenName)
    .map((bucket) => ({
      label: bucket.label,
      units: !bucket.hasHours
        ? // 🔴 A stipend line: no slots, no hours, no fabricated zero.
          EM_DASH
        : bucket.slots == null
          ? formatHours(bucket.hours)
          : `${formatSlots(bucket.slots)} · ${formatHours(bucket.hours)}`,
      amountCents: bucket.cents,
    }));
}

function byCanonicalThenName(
  a: { label: string },
  b: { label: string },
): number {
  const ai = CAGE_LINE_ORDER.indexOf(a.label);
  const bi = CAGE_LINE_ORDER.indexOf(b.label);
  // Cage resource types in their canonical Reports order; everything else
  // (program names on the work account) alphabetically, for stability.
  if (ai !== -1 || bi !== -1) {
    return (ai === -1 ? Number.MAX_SAFE_INTEGER : ai) -
      (bi === -1 ? Number.MAX_SAFE_INTEGER : bi);
  }
  return a.label.localeCompare(b.label);
}

function buildChargeRows(
  charges: readonly StatementChargeInput[],
): StatementChargeRow[] {
  return [...charges]
    .sort(
      (a, b) =>
        a.startAt.getTime() - b.startAt.getTime() ||
        a.description.localeCompare(b.description),
    )
    .map((charge) => ({
      date: pfaMonthDayPadded(charge.startAt),
      // 🔴 A charge with NO hours has no weekday and no clock times either.
      // Its `startAt`/`endAt` are a PAY PERIOD's bounds, so deriving a time
      // range from them prints "12:00 – 12:00 AM" against a $2,500 stipend —
      // a rendered fact that is not true, on the one document Mark hands to a
      // coach. `hours == null` is the same signal the summary line uses, so
      // the row and the line can never disagree about what kind of charge
      // this is.
      dayOfWeek: charge.hours == null ? EM_DASH : formatPfaWeekday(charge.startAt),
      timeRange:
        charge.hours == null
          ? EM_DASH
          : pfaTimeRange(charge.startAt, charge.endAt),
      description: charge.description,
      rateLabel: charge.rateLabel,
      // 🔴 Carried onto the ROW, not just the summary line. Without it an
      // off-slot booking printed `9:14 – 10:01 AM · $44.00/hr · $66.00` and the
      // reader's own arithmetic (47 min × $44/hr = $34.47) contradicted the
      // amount by ~2×. The slot count is the term that reconciles the two, and
      // SPEC §5.3 already required the existing Cage Detail column set, which
      // has it. Null on the work account, which has no slot model.
      slots: charge.slots,
      amountCents: charge.amountCents,
    }));
}

/* ── Labels ──────────────────────────────────────────────────────────────── */

/**
 * SPEC §5.0 — a full sentence with real names. Never "Balance", never "You
 * owe", never a bare signed number, and never appended to a figure.
 *
 * 🔴 The sentence FOLLOWS THE SIGN. A negative closing balance means the
 * account is overpaid and the direction has FLIPPED (§5.2), and the card
 * renders `directionLabel` beside `Math.abs(closingCents)` — so a stubbornly
 * "stated" direction on a negative balance would print "Alex Milone owes PFA ·
 * $40.00" for money PFA owes HIM. Zero keeps the stated direction: square is
 * not a flip.
 *
 * An overpayment is NEVER resolved by reaching into the other account — the
 * two ledgers do not cross (§11), so a cage credit stays a cage credit.
 */
function directionLabel(
  account: StatementAccount,
  coachName: string,
  closingCents: number,
): string {
  const coachOwesPfa = account === "cage" ? closingCents >= 0 : closingCents < 0;
  return coachOwesPfa ? `${coachName} owes PFA` : `PFA owes ${coachName}`;
}

/**
 * "Jul 1 – Jul 31, 2026", or "Dec 28, 2025 – Jan 3, 2026" across a year.
 *
 * Exported in Phase C for the many-coach ROLL-UP, which states the same period
 * as the statements it links to. It has to be this function and not a second
 * formatter: two spellings of one period on one tab is how a reader starts
 * wondering whether they are looking at the same range.
 */
export function statementPeriodLabel(period: StatementPeriod): string {
  const start = period.fromDate;
  const end = lastInstantOfPeriod(period);
  const startYear = pfaParts(start).year;
  const endYear = pfaParts(end).year;
  if (startYear === endYear) {
    return `${pfaMonthDay(start)} – ${pfaMonthDay(end)}, ${startYear}`;
  }
  return `${pfaMonthDay(start)}, ${startYear} – ${pfaMonthDay(end)}, ${endYear}`;
}

/**
 * The last instant of the inclusive period. `toDateExclusive` is PFA-midnight
 * of the day AFTER the period, so backing off 1ms lands on the period's final
 * day — the same trick `normalizeFilters` uses to turn `pfaMonthEnd` into an
 * inclusive `to`, and TZ-safe because it is formatted through the PFA-pinned
 * formatters rather than compared to anything local.
 */
function lastInstantOfPeriod(period: StatementPeriod): Date {
  return new Date(period.toDateExclusive.getTime() - 1);
}

/**
 * "Jul 1" — used in PROSE (the period header and the as-of labels), where a
 * zero-padded day reads as a serial number rather than a date.
 */
function pfaMonthDay(d: Date): string {
  return d.toLocaleDateString("en-US", {
    timeZone: PFA_TIMEZONE,
    month: "short",
    day: "numeric",
  });
}

/**
 * "Jul 02" — used in TABLE COLUMNS, which is the padding `StatementChargeRow`
 * and `StatementPaymentRow` document. Padded so the date column stays
 * left-aligned down a long charge detail list; unpadded in prose above it.
 */
function pfaMonthDayPadded(d: Date): string {
  return d.toLocaleDateString("en-US", {
    timeZone: PFA_TIMEZONE,
    month: "short",
    day: "2-digit",
  });
}

/**
 * "9:00 – 11:00 AM" within one meridiem, "9:00 AM – 3:00 PM" across it.
 * Collapsing the repeated AM/PM is the convention the statement mock uses and
 * keeps the column narrow enough to survive print.
 *
 * `trimEnd` rather than a fixed slice: newer ICU puts a NARROW NO-BREAK SPACE
 * (U+202F) before AM/PM, so a hard-coded 3-char cut would leave a stray
 * separator on some Node versions and not others.
 */
function pfaTimeRange(startAt: Date, endAt: Date): string {
  const start = formatPfaTime12h(startAt);
  const end = formatPfaTime12h(endAt);
  const meridiem = start.slice(-2);
  if (meridiem === end.slice(-2)) {
    return `${start.slice(0, -meridiem.length).trimEnd()} – ${end}`;
  }
  return `${start} – ${end}`;
}

/** "1 slot" / "16 slots". */
function formatSlots(slots: number): string {
  return `${slots} ${slots === 1 ? "slot" : "slots"}`;
}

/**
 * "8.0 h" · "0.25 h" · "1.25 h" — one decimal where that is exact, two where it
 * is not.
 *
 * 🔴 `toFixed(1)` alone ROUNDED THE UNIT THE MONEY CAME FROM. A single 15-minute
 * posted work log printed "0.3 h" beside "$7.50", and five of them printed
 * "1.3 h" beside "$37.50" when the pay was computed on 1.25 h. On a document
 * whose entire claim is arithmetic the reader can verify (SPEC §2 rule 1), the
 * printed hours have to be the hours the amount was calculated from — otherwise
 * "1.3 h × $30/hr" is $39.00 and the line visibly fails to foot by $1.50.
 *
 * Two decimals is exactly enough and no more: `hour_logs` are 15-minute
 * granular, so every work total is a multiple of 0.25, and cage hours come from
 * `slots / 2` so they are always .0 or .5. Nothing here needs a third decimal,
 * and trailing "8.00 h" would read as false precision — hence one decimal
 * whenever the second is zero.
 */
function formatHours(hours: number): string {
  const rounded = Math.round(hours * 100) / 100;
  // `rounded * 10` is an integer exactly when the hundredths digit is 0.
  return `${
    Number.isInteger(rounded * 10) ? rounded.toFixed(1) : rounded.toFixed(2)
  } h`;
}

/** "Zelle" / "Check" — the same capitalization `MethodBadge` already applies. */
function methodLabel(method: string): string {
  return method.charAt(0).toUpperCase() + method.slice(1);
}

/* ── Small shared helpers ────────────────────────────────────────────────── */

function sumCents(charges: readonly StatementChargeInput[]): number {
  return charges.reduce((total, charge) => total + charge.amountCents, 0);
}

/**
 * The rows `netCoachLedgers` is contracted to receive: CONFIRMED, non-deleted,
 * both directions. Its header comment makes filtering the caller's job and
 * routing its own — so this narrows, and does not route.
 */
function ledgerPayments(
  payments: readonly StatementPaymentInput[],
): LedgerPayment[] {
  return payments
    .filter((p) => p.deletedAt == null && p.status === "confirmed")
    .map((p) => ({ amountCents: p.amountCents, direction: p.direction }));
}
