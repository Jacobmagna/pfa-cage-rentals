// payment-statement SPEC §5 — the shape of a rendered statement.
//
// This is the CONTRACT between the (not yet built) statement engine and the
// presentational card. Deliberately written first, and deliberately made of
// already-formatted display strings for everything EXCEPT money: the engine
// owns date/rate/label formatting, the card owns layout, and money stays in
// integer cents until the last possible moment so the card can be the single
// place `formatDollarsExact` is applied.
//
// One shape serves BOTH accounts (§5.0). There is no CageStatement and no
// WorkStatement — the engine is parameterised by direction, so a second type
// here would be the first crack in that.

/** Which of a coach's two opposite-direction ledgers this statement is for. */
export type StatementAccount = "cage" | "work";

export const STATEMENT_ACCOUNTS: readonly StatementAccount[] = [
  "cage",
  "work",
] as const;

export function statementAccountLabel(account: StatementAccount): string {
  return account === "cage" ? "Cage rentals" : "Work pay";
}

/**
 * One summary line in CHARGES THIS PERIOD. On the cage account these are
 * resource types (cage / bullpen / weight room / group weight room, which is
 * exactly what `SummaryRow` already breaks out); on the work account they are
 * programs. Rates differ per line, which is why this is never one lump.
 */
export type StatementChargeLine = {
  label: string;
  /** Pre-formatted units, e.g. "16 slots · 8.0 h" or "24.0 h". */
  units: string;
  amountCents: number;
};

/**
 * One itemized charge. Shaped to mirror the existing reports `DetailRow` and
 * the Cage Detail sheet — the SPEC forbids a third rendering of a session row.
 */
export type StatementChargeRow = {
  /** "Jul 02" — day precision, PFA calendar. */
  date: string;
  /** "Thu" */
  dayOfWeek: string;
  /** "9:00 – 11:00 AM" */
  timeRange: string;
  /** "Cage 2" · "Weight Room (Group)" · "HS Summer Program-Throwing" */
  description: string;
  /**
   * "$44.00/hr" · "$100.00/session" · "No rate". Never "$0.00/hr" for a
   * missing rate — a log with no stamped rate says so, because a rendered
   * zero reads as a deliberate decision to pay nothing.
   */
  rateLabel: string;
  amountCents: number;
};

/** One payment row. The covers-through column is the whole feature. */
export type StatementPaymentRow = {
  /** When the money arrived — information only. NEVER used to place a payment in a period. */
  paidOn: string;
  /** "Zelle" · "Check" · "Cash" … */
  method: string;
  reference: string | null;
  /** "Jul 31", or null for a payment with no period stated. */
  coversThrough: string | null;
  amountCents: number;
  /**
   * Pending payments are SHOWN but never summed into a balance —
   * `netCoachLedgers` already enforces this and the statement must not
   * disagree with it.
   */
  pending: boolean;
};

export type Statement = {
  account: StatementAccount;
  /**
   * The direction as a full sentence with names: "Alex Milone owes PFA" /
   * "PFA owes Alex Milone". Never "Balance", never "You owe", never a bare
   * signed number (§5.0).
   */
  directionLabel: string;

  /** "Previous balance (as of Jun 30)" */
  openingLabel: string;
  /** "Statement balance as of Jul 31" */
  closingLabel: string;

  openingCents: number;
  chargesCents: number;
  paymentsCents: number;
  /** opening + charges − payments. Positive = the stated direction still holds. */
  closingCents: number;

  chargeLines: StatementChargeLine[];
  chargeRows: StatementChargeRow[];
  paymentRows: StatementPaymentRow[];

  /** §7 — the NOT INCLUDED block. Each is counted in NO period. */
  unappliedCents: number;
  chargesAfterCents: number;
  paymentsCoveringAfterCents: number;
  /** The all-time figure /admin/payments already shows for this account. */
  currentBalanceCents: number;

  /**
   * §11 — mandatory on the WORK account: the app has no real payout ledger,
   * so this figure is gross of cash handed over outside the system. Rendered
   * in the document, on screen AND in print. Null on the cage account, whose
   * charges are complete.
   */
  caveat: string | null;

  /** e.g. "Posted work only — rejected and held logs are excluded." */
  scopeNote: string | null;
};

/**
 * Both of a coach's accounts for ONE period. The card needs both even when
 * showing one, because the header names both balances with their directions
 * (§5.0) — that is the "clear on who paid who in the same area" half of the
 * design, and it is what keeps a switcher from hiding half the picture.
 *
 * 🔴 There is deliberately NO combined total field on this type. Not in the
 * header, not in a footer, not in print. The two ledgers are never summed
 * (§11) and the shape should make that impossible rather than merely
 * discouraged.
 */
export type StatementPair = {
  coachName: string;
  coachEmail: string;
  /** "Jul 1 – Jul 31, 2026" */
  periodLabel: string;
  /** "Jul 31" — used in the closing/as-of labels. */
  periodEndShort: string;
  cage: Statement;
  work: Statement;
};
