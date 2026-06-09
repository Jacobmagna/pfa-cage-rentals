// 1b #26/27: pure timing logic for cancelled (deleted) cage rentals.
// NO db imports — every input is a plain value so this stays unit-test
// friendly and reusable from both the recording path and the loader.
//
// A cancellation's "category" is DERIVED on read from three timestamps
// (the rental's start/end and when it was cancelled) rather than stored,
// so the policy thresholds below can change without a data migration.

// lead < 120 min (under 2h before start) → last_minute (concerning).
export const LAST_MINUTE_MINUTES = 120;
// 120 ≤ lead < 1440 min → short_notice; lead ≥ 1440 (24h) → advance.
export const SHORT_NOTICE_MINUTES = 1440;

export type CancelCategory =
  | "advance"
  | "short_notice"
  | "last_minute"
  | "mid_session"
  | "after_end";

/**
 * Minutes between the rental start and the cancellation. Positive = the
 * rental was cancelled BEFORE it started; negative = at/after start.
 */
export function leadTimeMinutes(startAt: Date, cancelledAt: Date): number {
  return Math.round((startAt.getTime() - cancelledAt.getTime()) / 60000);
}

/**
 * Categorize a cancellation from the rental's start/end and when it was
 * cancelled. Position relative to the rental window (mid_session /
 * after_end) is checked FIRST; otherwise we bucket by lead time.
 */
export function categorizeCancellation(
  startAt: Date,
  endAt: Date,
  cancelledAt: Date,
): CancelCategory {
  // Cancelled at/after the rental had already ended.
  if (cancelledAt.getTime() >= endAt.getTime()) return "after_end";
  // Cancelled while the rental was in progress (start ≤ cancel < end).
  if (cancelledAt.getTime() >= startAt.getTime()) return "mid_session";

  const lead = leadTimeMinutes(startAt, cancelledAt);
  if (lead >= SHORT_NOTICE_MINUTES) return "advance";
  if (lead >= LAST_MINUTE_MINUTES) return "short_notice";
  return "last_minute";
}

/** The "concerning" categories: very-late and during-the-rental cancels. */
export function isConcerning(cat: CancelCategory): boolean {
  return cat === "last_minute" || cat === "mid_session";
}

export type CoachCancelRow = {
  coachId: string;
  coachName: string | null;
  // true when the rental owner is the one who cancelled (cancelledBy ===
  // coachId). Admin-removed rentals (false) are excluded from the rollup.
  ownerCancellation: boolean;
  category: CancelCategory;
};

export type CoachCancelSummary = {
  coachId: string;
  coachName: string | null;
  total: number;
  lastMinute: number;
  midSession: number;
  shortNotice: number;
  advance: number;
  afterEnd: number;
  lateRatePct: number;
  repeatOffender: boolean;
};

/**
 * Per-coach pattern rollup. ONLY owner-cancellations feed the totals —
 * admin-removed rentals are ignored here (a coach shouldn't be penalized
 * for an admin removing their rental). late-rate % = concerning / total.
 */
export function summarizeByCoach(
  rows: CoachCancelRow[],
): CoachCancelSummary[] {
  const byCoach = new Map<string, CoachCancelSummary>();

  for (const row of rows) {
    if (!row.ownerCancellation) continue;
    let s = byCoach.get(row.coachId);
    if (!s) {
      s = {
        coachId: row.coachId,
        coachName: row.coachName,
        total: 0,
        lastMinute: 0,
        midSession: 0,
        shortNotice: 0,
        advance: 0,
        afterEnd: 0,
        lateRatePct: 0,
        repeatOffender: false,
      };
      byCoach.set(row.coachId, s);
    }
    s.total += 1;
    switch (row.category) {
      case "last_minute":
        s.lastMinute += 1;
        break;
      case "mid_session":
        s.midSession += 1;
        break;
      case "short_notice":
        s.shortNotice += 1;
        break;
      case "advance":
        s.advance += 1;
        break;
      case "after_end":
        s.afterEnd += 1;
        break;
    }
  }

  const summaries = [...byCoach.values()];
  for (const s of summaries) {
    const concerning = s.lastMinute + s.midSession;
    s.lateRatePct = s.total > 0 ? Math.round((100 * concerning) / s.total) : 0;
    s.repeatOffender = concerning >= 2 && s.lateRatePct >= 50;
  }

  // Most-concerning coaches first: by concerning count, then late-rate.
  summaries.sort((a, b) => {
    const ac = a.lastMinute + a.midSession;
    const bc = b.lastMinute + b.midSession;
    if (bc !== ac) return bc - ac;
    return b.lateRatePct - a.lateRatePct;
  });

  return summaries;
}
