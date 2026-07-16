// Block 5a — PURE reporting helpers for the operator FINANCES dashboard. No DB,
// no network: parse the optional YYYY-MM-DD period bounds into instants the
// query layer filters by, and compute the on-time-collection KPI from a
// pre-filtered installment set. The impure layer (src/travel/reporting.ts) loads
// the period-scoped rows and renders them; this module holds only the math.
//
// This block moves NO money and writes NO rows — it is a pure READ/reporting
// spine over tables that already exist (payments / refunds / invoices /
// installments). The operator settlement / commission engine is a LATER task.
//
// TIMEZONE: the rest of the travel code uses plain UTC `Date` arithmetic (see
// src/travel/plans.ts — addMonths/new Date, no tz helper); travel has NO
// America/Los_Angeles convention like Northstar's billing layer. So we parse the
// period bounds at UTC-midnight to MATCH the travel codebase. `toDate` is the
// EXCLUSIVE UTC-midnight of the day AFTER `to` (callers compare `< toDate`), so
// the whole `to` day is covered with no next-day leak.
//
// MONEY DISCIPLINE: integer cents only — sumCents throws on a non-integer amount,
// mirroring Northstar's attachRunningBalance discipline.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Default grace window (days) the caller passes to onTimeCollectionRate: an
// installment paid within `dueDate + graceDays` still counts as on time.
export const DEFAULT_GRACE_DAYS = 5;

export type ReportPeriod = {
  /** UTC instant at midnight on `from` — SQL `>=` lower bound, or null (all-time). */
  fromDate: Date | null;
  /**
   * EXCLUSIVE UTC instant at midnight of the day AFTER `to` — callers compare a
   * timestamp `< toDate` (strictly-less-than) so the whole `to` day is included
   * and the next day's first instant is excluded (no leak). null for all-time.
   */
  toDate: Date | null;
  /** Human label for the period bar / headers ("All time" or a range). */
  label: string;
};

/**
 * Validate/normalize the optional `from`/`to` (YYYY-MM-DD) into a period. PURE +
 * total: ANY invalid/empty input falls back to all-time (nulls, label "All
 * time") — we never throw on a user-supplied querystring value. Follows
 * Northstar's parseReconcilePeriod semantics but at UTC-midnight (travel has no
 * tz convention — see the module header).
 *
 * No args (or both invalid) → all-time, "All time".
 * Only `from` → "From <date>"; only `to` → "Through <date>"; both → "<a> – <b>".
 * An inverted range (from > to) is NOT swapped — an empty result is the honest
 * answer to a nonsensical range.
 */
export function parseReportPeriod(from?: string, to?: string): ReportPeriod {
  const fromOk = isDateString(from) ? from : null;
  const toOk = isDateString(to) ? to : null;

  const fromDate = fromOk ? utcMidnight(fromOk) : null;
  // `to` covers the whole day: the exclusive upper bound is UTC-midnight of the
  // NEXT day, so callers compare a timestamp `< toDate`.
  const toDate = toOk ? utcNextMidnight(toOk) : null;

  let label: string;
  if (fromOk && toOk) label = `${fromOk} – ${toOk}`;
  else if (fromOk) label = `From ${fromOk}`;
  else if (toOk) label = `Through ${toOk}`;
  else label = "All time";

  return { fromDate, toDate, label };
}

export type OnTimeCollection = {
  /** Installments due in the period (caller pre-filters by dueDate). */
  dueCount: number;
  /** Of those, how many were paid on time (paidDate <= dueDate + graceDays). */
  onTimeCount: number;
  /** onTimeCount / dueCount as a % rounded to 1dp, or null when nothing is due. */
  ratePct: number | null;
};

/**
 * On-time collection rate over a pre-filtered installment set (the caller has
 * already narrowed to installments whose dueDate falls in the period). An
 * installment with no dueDate is skipped (it can't be "due"). It counts as on
 * time when it has a paidDate AND that paidDate is at or before
 * `dueDate + graceDays`. Returns a null rate when nothing is due (avoids 0/0).
 * PURE.
 */
export function onTimeCollectionRate(
  installments: { dueDate: Date | null; paidDate: Date | null }[],
  graceDays: number,
): OnTimeCollection {
  const graceMs = graceDays * 24 * 60 * 60 * 1000;
  let dueCount = 0;
  let onTimeCount = 0;
  for (const inst of installments) {
    if (!inst.dueDate) continue; // no due date → not a due installment
    dueCount += 1;
    if (
      inst.paidDate &&
      inst.paidDate.getTime() <= inst.dueDate.getTime() + graceMs
    ) {
      onTimeCount += 1;
    }
  }
  const ratePct =
    dueCount === 0 ? null : round1((onTimeCount / dueCount) * 100);
  return { dueCount, onTimeCount, ratePct };
}

export type OnTimeBonusTier = "full" | "half" | "none";

/**
 * Map an on-time rate % to a bonus tier: ≥97 → "full", ≥92 → "half", else (or
 * null) → "none". This is a KPI DISPLAY helper only — the actual bonus payout
 * engine is a later task; here we just expose the tier label. PURE.
 */
export function onTimeBonusTier(ratePct: number | null): OnTimeBonusTier {
  if (ratePct === null) return "none";
  if (ratePct >= 97) return "full";
  if (ratePct >= 92) return "half";
  return "none";
}

/**
 * Sum an integer-cents array. Throws on any non-integer amount (NaN/float = a
 * data bug; integer cents is invariant across the billing layer — mirrors
 * Northstar's attachRunningBalance). PURE.
 */
export function sumCents(amounts: number[]): number {
  let total = 0;
  for (const amt of amounts) {
    if (!Number.isInteger(amt)) {
      throw new Error(`sumCents: amountCents must be an integer (got ${amt})`);
    }
    total += amt;
  }
  return total;
}

// ── internals ────────────────────────────────────────────────────────────────

/** Round to 1 decimal place (avoids binary-float display noise like 66.66666). */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** UTC-midnight instant for a validated YYYY-MM-DD string. */
function utcMidnight(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** UTC-midnight of the day AFTER a validated YYYY-MM-DD (exclusive upper bound). */
function utcNextMidnight(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1));
}

/**
 * True only for a real YYYY-MM-DD calendar date. The regex shape alone passes
 * impossible dates ("2026-13-99"); we round-trip y/m/d through Date.UTC so an
 * out-of-range month/day is rejected (→ all-time fallback) rather than
 * producing a rolled-over instant.
 */
function isDateString(v: string | undefined): v is string {
  if (typeof v !== "string" || !DATE_RE.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return (
    probe.getUTCFullYear() === y &&
    probe.getUTCMonth() === m - 1 &&
    probe.getUTCDate() === d
  );
}
