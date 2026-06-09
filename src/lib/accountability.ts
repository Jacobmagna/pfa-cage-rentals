// 1b add-on — pure logic for the per-coach Coach Accountability scorecard.
//
// NO db imports — every input is a plain value (timestamps / already-counted
// per-coach numbers) so this stays unit-test friendly and reusable from the
// loader. Sibling of src/lib/cancellation.ts: constants + pure predicates +
// a shape/sort helper. The actual COUNTING lives in the loader
// (src/lib/server/accountability-data.ts); this file only defines the
// policy thresholds and shapes/sorts the per-coach rows.

// A work-hour log entered more than this many hours after the session ended
// is "late logging" (concerning) — `hour_logs.createdAt − endAt > 48h`.
export const LATE_LOG_HOURS = 48;
// Logged duration may exceed the scheduled block duration by up to this many
// minutes before it counts as "over-logged".
export const OVER_LOG_MARGIN_MINUTES = 30;

/** True iff the log was created > LATE_LOG_HOURS after the session ended. */
export function isLateLog(createdAt: Date, endAt: Date): boolean {
  return (
    createdAt.getTime() - endAt.getTime() > LATE_LOG_HOURS * 3_600_000
  );
}

/**
 * Minutes the logged window exceeds the scheduled block window. Positive =
 * logged longer than scheduled; negative = logged shorter. Both durations
 * are rounded to whole minutes first so the margin compare is stable.
 */
export function overLoggedMinutes(
  logStart: Date,
  logEnd: Date,
  blockStart: Date,
  blockEnd: Date,
): number {
  const logged = Math.round((logEnd.getTime() - logStart.getTime()) / 60000);
  const scheduled = Math.round(
    (blockEnd.getTime() - blockStart.getTime()) / 60000,
  );
  return logged - scheduled;
}

/** True iff the logged window is over the scheduled one by > the margin. */
export function isOverLogged(
  logStart: Date,
  logEnd: Date,
  blockStart: Date,
  blockEnd: Date,
): boolean {
  return (
    overLoggedMinutes(logStart, logEnd, blockStart, blockEnd) >
    OVER_LOG_MARGIN_MINUTES
  );
}

export type CoachScorecardRow = {
  coachId: string;
  coachName: string | null;
  noShows: number;
  lateCancels: number;
  // concerning-cancel rate (last_minute + mid_session) / total owner cancels.
  lateCancelRatePct: number;
  repeatCanceller: boolean;
  lateLogs: number;
  overLogged: number;
  totalConcerns: number;
};

// Input to buildScorecard: already-counted per-coach signal numbers plus the
// cancel-summary fields. totalConcerns is derived here, not passed in.
export type CoachSignalCounts = {
  coachId: string;
  coachName: string | null;
  noShows: number;
  lateCancels: number;
  lateCancelRatePct: number;
  repeatCanceller: boolean;
  lateLogs: number;
  overLogged: number;
};

/**
 * Shape + sort the per-coach scorecard rows. Computes
 * `totalConcerns = noShows + lateCancels + lateLogs + overLogged` and sorts
 * most-concerning first (totalConcerns desc), tie-broken by coachName
 * (nulls last) so the order is deterministic.
 */
export function buildScorecard(
  perCoach: CoachSignalCounts[],
): CoachScorecardRow[] {
  const rows: CoachScorecardRow[] = perCoach.map((c) => ({
    coachId: c.coachId,
    coachName: c.coachName,
    noShows: c.noShows,
    lateCancels: c.lateCancels,
    lateCancelRatePct: c.lateCancelRatePct,
    repeatCanceller: c.repeatCanceller,
    lateLogs: c.lateLogs,
    overLogged: c.overLogged,
    totalConcerns: c.noShows + c.lateCancels + c.lateLogs + c.overLogged,
  }));

  rows.sort((a, b) => {
    if (b.totalConcerns !== a.totalConcerns) {
      return b.totalConcerns - a.totalConcerns;
    }
    const an = a.coachName ?? "￿";
    const bn = b.coachName ?? "￿";
    return an.localeCompare(bn);
  });

  return rows;
}
