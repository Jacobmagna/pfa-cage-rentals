// stipend SPEC §6.3 / §7.1 — THE PURE HALF of the stipend write path.
//
// Everything here decides; nothing here touches the database, React, or the
// clock. `now` arrives as a parameter, exactly as `pay-period.ts` and
// `statementPeriodPresets` already do, so every boundary case in this file is
// testable with literals instead of a mock.
//
// ── Why a planner instead of guards inlined in the action ───────────────────
// The rules that keep two stipend versions from overlapping are the rules that
// keep a coach from being paid twice for the same half-month. Under neon-http
// there is no interactive transaction (see the module note in
// `stipend-actions.ts`), so the check and the write are two statements and the
// check has to be *provable* on its own. A pure planner is provable: every
// refusal below is a unit test with literal dates, proven RED before it was
// trusted (discipline rule 7).
//
// ── The shape of the invariant ─────────────────────────────────────────────
// `coach_stipends` rows are half-open windows `[effectiveFrom, effectiveTo)`
// on the pay-period grid. For one coach they must TILE — never overlap, never
// be written out of order. This module enforces that by making the history
// APPEND-ONLY and FORWARD-ONLY:
//
//   • a new version must start strictly AFTER every version already on file;
//   • writing it closes the currently-open row at exactly that instant.
//
// Two windows that meet at a shared boundary cannot overlap, so "no overlap"
// stops being a check that could be raced and becomes a property of the shape.
// The only thing a concurrent second writer could do is fail the
// already-on-file check — which is the safe direction.

import {
  isPayPeriodStart,
  payPeriodFor,
  payPeriodLabel,
  payPeriodsBetween,
  type PayPeriod,
} from "@/lib/pay-period";

/**
 * One `coach_stipends` row, narrowed to the fields the temporal rules read.
 * Deliberately structural rather than the drizzle row type: the planner must
 * stay importable by a test that builds a version out of two dates.
 */
export type StipendVersion = {
  id: string;
  amountCents: number;
  /** PFA-midnight on a pay-period boundary. Inclusive. */
  effectiveFrom: Date;
  /** NULL = still in effect. Exclusive upper bound when set. */
  effectiveTo: Date | null;
};

/**
 * What the action must write, and nothing else. `closeRowId` is null when the
 * coach has no open version (their first stipend, or one that was already
 * ended) — there is nothing to close.
 */
export type StipendChangePlan = {
  /** The row to stamp `effectiveTo` on, or null. */
  closeRowId: string | null;
  /** The instant to close it at — always the new version's start. */
  closeAt: Date | null;
  /** The new version's window start. */
  effectiveFrom: Date;
  amountCents: number;
  /**
   * The pay periods this change makes payable that are already over or
   * running. EMPTY for the normal forward-dated case. Non-empty is exactly
   * the §12.4 back-pay case, and is what the backdate confirmation names.
   */
  backdatedPeriods: PayPeriod[];
};

/** Ending a stipend: one row gets an upper bound, nothing is inserted. */
export type StipendEndPlan = {
  closeRowId: string;
  closeAt: Date;
  backdatedPeriods: PayPeriod[];
};

/**
 * 🔴 Every refusal in this module is one of these. They are thrown, not
 * returned, because there is no partial success to report: a plan that cannot
 * be built must not reach the database at all.
 *
 * `code` is the stable identifier the UI switches on; `message` is written to
 * be shown to Mark verbatim.
 */
export class StipendPlanError extends Error {
  constructor(
    readonly code:
      | "NOT_PERIOD_START"
      | "NOT_FORWARD_ONLY"
      | "NO_OPEN_VERSION"
      | "BACKDATE_NOT_CONFIRMED"
      | "AMOUNT_NOT_POSITIVE",
    message: string,
    /** Populated only on BACKDATE_NOT_CONFIRMED. */
    readonly backdatedPeriods: PayPeriod[] = [],
  ) {
    super(message);
    this.name = "StipendPlanError";
  }
}

/**
 * Plan a NEW stipend version for one coach.
 *
 * @param existing every `coach_stipends` row this coach already has, in any
 *   order. The planner sorts; callers must not be trusted to.
 * @param confirmBackdate the caller has SEEN the affected periods and still
 *   wants them. See §12.4 — this is the mirror of the re-price decrease
 *   guard, and it exists for the same reason: Mark pays coaches outside the
 *   system, so money the app newly claims is owed may already be settled.
 *
 * @throws StipendPlanError
 */
export function planSetStipend(input: {
  existing: StipendVersion[];
  amountCents: number;
  effectiveFrom: Date;
  now: Date;
  confirmBackdate?: boolean;
}): StipendChangePlan {
  const { existing, amountCents, effectiveFrom, now } = input;

  // ── 1. The amount ────────────────────────────────────────────────────────
  // 🔴 STRICTLY POSITIVE, and this DEVIATES from SPEC §6.3's `>= 0`.
  //
  // `resolveStipendCovered` puts a coach on a stipend by the PRESENCE of an
  // amount, not its size (`coachStipendAmountCents != null`). So a $0 stipend
  // would zero the pay on every covered log — real hours, no hourly pay — and
  // then earn $0 for the period. The coach works the half-month and is paid
  // nothing, with every gate green and every screen internally consistent.
  //
  // There is no use for that state: taking a coach OFF a stipend is
  // `planEndStipend`, which is explicit and reversible. Refusing $0 here costs
  // nothing and closes the only way this feature can silently pay someone zero.
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new StipendPlanError(
      "AMOUNT_NOT_POSITIVE",
      "A stipend must be a whole number of cents greater than $0. " +
        "To take a coach off a stipend, end it instead of setting it to $0.",
    );
  }

  // ── 2. The boundary ──────────────────────────────────────────────────────
  // §6.3 — a stipend that starts mid-period is not representable under Mark's
  // all-or-nothing rule. Refuse loudly rather than round to a period he did
  // not pick.
  assertPeriodStart(effectiveFrom, "start");

  // ── 3. Forward-only ──────────────────────────────────────────────────────
  // Sorting here rather than trusting the caller's order is deliberate: the
  // action's SELECT has an ORDER BY today, and a future edit to that query
  // must not be able to turn this check into a coin flip.
  const sorted = [...existing].sort(
    (a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime(),
  );
  const latest = sorted.at(-1) ?? null;

  if (latest && latest.effectiveFrom.getTime() >= effectiveFrom.getTime()) {
    throw new StipendPlanError(
      "NOT_FORWARD_ONLY",
      `This coach already has a stipend version starting ` +
        `${payPeriodLabel(payPeriodFor(latest.effectiveFrom))}. A new amount ` +
        `must start in a LATER pay period — past periods are never rewritten.`,
    );
  }

  // A version that was explicitly ENDED after the new start would still
  // overlap it. Unreachable while every write goes through this planner (an
  // end always closes the newest row), but the invariant is what money
  // correctness rests on, so it is checked rather than reasoned about.
  const straddling = sorted.find(
    (v) =>
      v.effectiveTo !== null &&
      v.effectiveTo.getTime() > effectiveFrom.getTime(),
  );
  if (straddling) {
    throw new StipendPlanError(
      "NOT_FORWARD_ONLY",
      "An existing stipend version already covers that pay period.",
    );
  }

  // ── 4. The §12.4 back-pay guard ──────────────────────────────────────────
  const backdatedPeriods = periodsAlreadyRunning(effectiveFrom, now);
  if (backdatedPeriods.length > 0 && input.confirmBackdate !== true) {
    throw new StipendPlanError(
      "BACKDATE_NOT_CONFIRMED",
      backdateMessage(backdatedPeriods, amountCents),
      backdatedPeriods,
    );
  }

  // ── 5. The plan ──────────────────────────────────────────────────────────
  // The open row is closed at exactly the new row's start, so the two windows
  // meet and cannot overlap.
  const open = sorted.find((v) => v.effectiveTo === null) ?? null;

  return {
    closeRowId: open?.id ?? null,
    closeAt: open ? effectiveFrom : null,
    effectiveFrom,
    amountCents,
    backdatedPeriods,
  };
}

/**
 * Plan the END of a coach's current stipend — they come off it from
 * `effectiveTo` forward. Nothing is inserted and nothing already earned is
 * touched: `coach_stipend_earnings` rows stand on their own (Mark's Q3).
 *
 * @throws StipendPlanError
 */
export function planEndStipend(input: {
  existing: StipendVersion[];
  effectiveTo: Date;
  now: Date;
  confirmBackdate?: boolean;
}): StipendEndPlan {
  const { existing, effectiveTo, now } = input;

  assertPeriodStart(effectiveTo, "end");

  const open = existing.find((v) => v.effectiveTo === null) ?? null;
  if (!open) {
    throw new StipendPlanError(
      "NO_OPEN_VERSION",
      "This coach is not currently on a stipend.",
    );
  }

  // The window must stay non-empty: a row ending where it starts covers no
  // period at all, and would resolve to nothing while still looking like a
  // stipend in the history.
  if (effectiveTo.getTime() <= open.effectiveFrom.getTime()) {
    throw new StipendPlanError(
      "NOT_FORWARD_ONLY",
      `The stipend must end AFTER it started ` +
        `(${payPeriodLabel(payPeriodFor(open.effectiveFrom))}).`,
    );
  }

  // Ending a stipend in a period that is already running takes away pay for
  // work that may already be done. Same guard, opposite sign — and this is the
  // case the standing handoff rule names directly: never apply a pay DECREASE
  // without asking Mark what's already been paid.
  const backdatedPeriods = periodsAlreadyRunning(effectiveTo, now);
  if (backdatedPeriods.length > 0 && input.confirmBackdate !== true) {
    throw new StipendPlanError(
      "BACKDATE_NOT_CONFIRMED",
      `Ending the stipend then removes it from ` +
        `${describePeriods(backdatedPeriods)}, which ` +
        `${backdatedPeriods.length === 1 ? "is" : "are"} already under way. ` +
        "Re-submit with confirmBackdate to apply it.",
      backdatedPeriods,
    );
  }

  return { closeRowId: open.id, closeAt: effectiveTo, backdatedPeriods };
}

/* ── internals ───────────────────────────────────────────────────────────── */

function assertPeriodStart(d: Date, which: "start" | "end"): void {
  if (Number.isNaN(d.getTime())) {
    throw new StipendPlanError(
      "NOT_PERIOD_START",
      `The stipend ${which} date is not a valid date.`,
    );
  }
  if (!isPayPeriodStart(d)) {
    throw new StipendPlanError(
      "NOT_PERIOD_START",
      `A stipend can only ${which} on the 1st or the 16th — pay periods run ` +
        "the 1st through the 15th and the 16th through the end of the month.",
    );
  }
}

/**
 * The pay periods from `effectiveFrom` up to and INCLUDING the one containing
 * `now`. Empty when `effectiveFrom` is in a future period, which is the normal
 * case and the one that must cost nothing.
 *
 * ⚠️ The CURRENT period counts as backdated. It is already running, so hours
 * inside it may already be logged and the change is already retroactive for
 * them. Treating "this period" as safe is exactly the off-by-one that would
 * make the guard miss the most likely real mistake.
 */
function periodsAlreadyRunning(effectiveFrom: Date, now: Date): PayPeriod[] {
  const currentPeriod = payPeriodFor(now);
  if (effectiveFrom.getTime() > currentPeriod.fromDate.getTime()) return [];
  // `payPeriodsBetween` is half-open and OVERLAP-based, so ending it one
  // millisecond past the current period's start yields exactly the periods
  // from `effectiveFrom` through the current one, inclusive.
  return payPeriodsBetween(
    effectiveFrom,
    new Date(currentPeriod.fromDate.getTime() + 1),
  );
}

function describePeriods(periods: PayPeriod[]): string {
  if (periods.length === 1) return payPeriodLabel(periods[0]);
  return (
    `${periods.length} pay periods (${payPeriodLabel(periods[0])} through ` +
    `${payPeriodLabel(periods[periods.length - 1])})`
  );
}

function backdateMessage(periods: PayPeriod[], amountCents: number): string {
  const each = `$${(amountCents / 100).toFixed(2)}`;
  const most = `$${((amountCents * periods.length) / 100).toFixed(2)}`;
  return (
    `This starts the stipend in ${describePeriods(periods)}, which ` +
    `${periods.length === 1 ? "is" : "are"} already under way. ` +
    `The coach becomes owed ${each} per period — up to ${most} — for work ` +
    "that may already have been paid outside the app. " +
    "Re-submit with confirmBackdate to apply it."
  );
}
