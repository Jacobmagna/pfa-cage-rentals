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
//   • a new version must start strictly AFTER every version that SURVIVES the
//     write (see the replacement rule below);
//   • writing it closes the currently-open row at exactly that instant.
//
// ── The ONE exception, and it is deliberately narrow ───────────────────────
// A version that has not started yet AND starts in the SAME pay period as the
// one being written is REPLACED rather than appended to. It has paid nobody —
// no period it governs has begun — so replacing it rewrites no history. That
// is the "wrong number" / "wrong coach" correction, and without it a stipend
// set up in August for a September start could not be fixed or removed before
// it paid. ⚠️ Same period ONLY: a $2,500-from-Sep-1 plus $3,000-from-Oct-1
// schedule is legitimate, and a broader rule would silently delete the
// September row when October was saved.
//
// Two windows that meet at a shared boundary cannot overlap, so "no overlap"
// stops being a check that could be raced and becomes a property of the shape.
// The only thing a concurrent second writer could do is fail the
// already-on-file check — which is the safe direction.

import { formatDollarsExact } from "@/lib/format-money";
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
  /**
   * 🔴 Versions that had NOT YET TAKEN EFFECT, at the SAME pay period as this
   * one, and are therefore being replaced outright.
   *
   * A row whose `effectiveFrom` is still in the future has never paid anybody:
   * no period it governs has begun, so no earning can reference it. Deleting it
   * rewrites nothing, which is why this does not violate the append-only rule —
   * that rule protects HISTORY, and a future row is not history yet.
   *
   * ⚠️ SAME PERIOD ONLY. A future version at a DIFFERENT period is a scheduled
   * change, not a mistake, and is closed off in the normal way instead.
   *
   * Without this, a fat-fingered amount (or a stipend put on the wrong coach)
   * set up in August for a September start could not be corrected OR cancelled
   * before it paid: the forward-only guard refused a re-set of the same period,
   * and the end guard refused to close a window that had not opened. The
   * earliest reachable end was the FOLLOWING period, so the wrong amount was
   * locked in for a full half-month, on a payroll surface with no void UI.
   */
  replacedRowIds: string[];
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
 * CANCELLING a stipend that has not started yet — the mirror of
 * `replacedRowIds` above, for when the answer is "remove it" rather than
 * "replace it with a different amount".
 *
 * Nothing is closed and nothing is inserted: the rows are deleted, and any
 * earlier version that was closed off to make room for them is REOPENED. That
 * second half is the part it is easy to miss — cancelling September must put
 * the coach back on whatever they were on in August, not leave them on nothing.
 */
export type StipendCancelPlan = {
  deleteRowIds: string[];
  /** The version to un-close, or null when there was nothing before. */
  reopenRowId: string | null;
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
      | "AMOUNT_NOT_POSITIVE"
      /** Cancel was asked for, but the stipend has already started. */
      | "ALREADY_STARTED",
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

  // ── 3. Forward-only, over the versions that have actually STARTED ────────
  // Sorting here rather than trusting the caller's order is deliberate: the
  // action's SELECT has an ORDER BY today, and a future edit to that query
  // must not be able to turn this check into a coin flip.
  const sorted = [...existing].sort(
    (a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime(),
  );

  // 🔴 THE NARROW RULE THAT MAKES A NOT-YET-STARTED STIPEND CORRECTABLE.
  //
  // A version is REPLACED only when it has not started AND the new version
  // starts in the SAME pay period. That is the "I typed the wrong number" /
  // "I picked the wrong coach" case, and nothing else.
  //
  // ⚠️ NOT "replace every future version". Scheduling $2,500 from Sep 1 and
  // then $3,000 from Oct 1 is a legitimate two-step plan, and a broader rule
  // would silently delete the September row when the October one was saved —
  // trading the bug being fixed here for a worse one. Anything that does not
  // collide with the new start is left exactly alone and closed off in the
  // normal forward-only way.
  const replaced = sorted.filter(
    (v) =>
      v.effectiveFrom.getTime() > now.getTime() &&
      v.effectiveFrom.getTime() === effectiveFrom.getTime(),
  );
  const replacedRowIds = replaced.map((v) => v.id);
  // The instants that the rows being deleted had CLOSED an earlier row at. A
  // boundary created by a row that is going away is not a real boundary.
  const vacatedBoundaries = new Set(
    replaced.map((v) => v.effectiveFrom.getTime()),
  );

  // Forward-only is enforced against everything that SURVIVES this write.
  const remaining = sorted.filter((v) => !replacedRowIds.includes(v.id));
  const latest = remaining.at(-1) ?? null;

  if (latest && latest.effectiveFrom.getTime() >= effectiveFrom.getTime()) {
    throw new StipendPlanError(
      "NOT_FORWARD_ONLY",
      latest.effectiveFrom.getTime() <= now.getTime()
        ? `This coach's stipend already started in ` +
          `${payPeriodLabel(payPeriodFor(latest.effectiveFrom))}. A new amount ` +
          `must start in a LATER pay period — a period that has already begun ` +
          `is never rewritten.`
        : `This coach already has a stipend scheduled from ` +
          `${payPeriodLabel(payPeriodFor(latest.effectiveFrom))}. Pick that ` +
          `period to change it, or a later one to schedule another change.`,
    );
  }

  // A version that was explicitly ENDED after the new start would still
  // overlap it. Unreachable while every write goes through this planner (an
  // end always closes the newest row), but the invariant is what money
  // correctness rests on, so it is checked rather than reasoned about.
  // ⚠️ A boundary left behind by a row we are about to delete does not count.
  const straddling = remaining.find(
    (v) =>
      v.effectiveTo !== null &&
      v.effectiveTo.getTime() > effectiveFrom.getTime() &&
      !vacatedBoundaries.has(v.effectiveTo.getTime()),
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
  // The latest STARTED row is closed at exactly the new row's start, so the
  // two windows meet and cannot overlap.
  //
  // It is closed when it is either still open, or was closed only to make room
  // for a row we are now deleting — in that second case its boundary has to
  // MOVE to the replacement's start, or the coach silently falls off the
  // stipend in the gap between the two. A row that someone explicitly ENDED is
  // left exactly as it is.
  const closeRow =
    latest &&
    (latest.effectiveTo === null ||
      vacatedBoundaries.has(latest.effectiveTo.getTime()))
      ? latest
      : null;

  return {
    closeRowId: closeRow?.id ?? null,
    closeAt: closeRow ? effectiveFrom : null,
    replacedRowIds,
    effectiveFrom,
    amountCents,
    backdatedPeriods,
  };
}

/**
 * Cancel a stipend that has NOT STARTED YET — remove it outright rather than
 * replacing it with a different amount.
 *
 * This is the "wrong coach" escape hatch. Setting a stipend on the wrong person
 * used to be unrecoverable through the UI: it could not be re-set (forward-only
 * refused the same period) and it could not be ended (the end guard refused to
 * close a window that had not opened), so the earliest reachable removal was
 * the FOLLOWING period — by which point they had earned one.
 *
 * @throws StipendPlanError
 */
export function planCancelStipend(input: {
  existing: StipendVersion[];
  now: Date;
}): StipendCancelPlan {
  const { existing, now } = input;
  const sorted = [...existing].sort(
    (a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime(),
  );
  const notStarted = sorted.filter(
    (v) => v.effectiveFrom.getTime() > now.getTime(),
  );

  if (notStarted.length === 0) {
    const open = sorted.find((v) => v.effectiveTo === null) ?? null;
    throw new StipendPlanError(
      open ? "ALREADY_STARTED" : "NO_OPEN_VERSION",
      open
        ? "This stipend has already started, so it cannot be cancelled — " +
          "end it from a future pay period instead. Anything already earned " +
          "stays earned."
        : "This coach is not currently on a stipend.",
    );
  }

  // Whatever the deleted rows displaced has to come back. Without this,
  // cancelling a September change would leave August's version closed off and
  // the coach on no stipend at all — a silent pay cut produced by an undo.
  const vacatedBoundaries = new Set(
    notStarted.map((v) => v.effectiveFrom.getTime()),
  );
  const settled = sorted.filter(
    (v) => v.effectiveFrom.getTime() <= now.getTime(),
  );
  const previous = settled.at(-1) ?? null;
  const reopenRowId =
    previous &&
    previous.effectiveTo !== null &&
    vacatedBoundaries.has(previous.effectiveTo.getTime())
      ? previous.id
      : null;

  return { deleteRowIds: notStarted.map((v) => v.id), reopenRowId };
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
    // ⚠️ Point at the action that DOES work. A stipend that has not started
    // yet is cancelled, not ended, and a bare refusal here left the admin with
    // no reachable way to undo a stipend they had just set on the wrong coach.
    const notStartedYet = open.effectiveFrom.getTime() > now.getTime();
    throw new StipendPlanError(
      "NOT_FORWARD_ONLY",
      notStartedYet
        ? `This stipend has not started yet — it begins ` +
          `${payPeriodLabel(payPeriodFor(open.effectiveFrom))}. Cancel it ` +
          `instead, or pick a pay period after it starts.`
        : `The stipend must end AFTER it started ` +
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
      // ⚠️ No "re-submit with confirmBackdate" here. That named a form field
      // to a non-technical admin, and pointed away from the confirm button
      // sitting directly beneath this sentence.
      `Ending the stipend then removes it from ` +
        `${describePeriods(backdatedPeriods)}, which ` +
        `${backdatedPeriods.length === 1 ? "is" : "are"} already under way.`,
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
  // 🔴 `formatDollarsExact`, not `toFixed(2)`. This message sits on the SAME
  // card as the current-amount line and the history table, both of which use
  // the shared formatter — so `toFixed` printed "$2500.00" beside "$2,500.00":
  // two formats for one number, inside the most important warning in the
  // feature.
  const each = formatDollarsExact(amountCents);
  const total = formatDollarsExact(amountCents * periods.length);
  // "owed $2,500.00 per period — up to $2,500.00" read as broken arithmetic
  // when there was only one period and the two figures were the same number.
  const cost =
    periods.length === 1
      ? `The coach becomes owed ${each}`
      : `The coach becomes owed ${each} per period — ${total} in total`;
  return (
    `This starts the stipend in ${describePeriods(periods)}, which ` +
    `${periods.length === 1 ? "is" : "are"} already under way. ` +
    `${cost} for work that may already have been paid outside the app.`
  );
}
