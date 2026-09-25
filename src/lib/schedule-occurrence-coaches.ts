// WHO IS ON EACH OCCURRENCE AFTER A WHOLE-SERIES EDIT.
//
// ── THE DEFECT THIS EXISTS TO END (Nick Milone, reported 2026-09-24) ──────
// Editing a whole series DELETES every future occurrence and re-inserts it
// from the series definition (`editProgramScheduleSeriesInternal`). That is
// the only way the materialized model can apply a definition change, and it
// is not going to change here. What it did WRONG was re-stamp every new
// occurrence with the series' coach set, so a coach swap somebody had made
// on ONE date was silently destroyed by the next series-wide edit.
//
// Nick lived it weekly: the series says Jorge, he put JT on one Saturday, he
// later edited the series to fix the following weeks, and JT turned back into
// Jorge. He re-did it three times and reported that the app "won't sync".
// From his chair the app was discarding his work with no message; from the
// code's chair it was doing exactly what it was told. Esther asked whether it
// was the engine or Nick not doing his job. It was the engine.
//
// ── THE RULE ──────────────────────────────────────────────────────────────
// An occurrence whose coach set DIFFERS from the series' PREVIOUS coach set
// was changed by a human, and keeps its own coaches. Every other occurrence
// takes the new set.
//
// 🔴 COMPARING AGAINST THE **PREVIOUS** DEFINITION IS THE WHOLE TRICK, and it
// is what makes this work with no new column. The regenerate re-stamps every
// future occurrence from the definition, so the instant a series edit
// finishes, "future occurrence" and "series definition" agree BY
// CONSTRUCTION. Any divergence that exists when the NEXT edit runs therefore
// got there by somebody editing that one date. The marker is not stored
// because the data already carries it.
//
// The alternative — a `customized_at` column on the block — was considered
// and rejected: it is a migration, it has to be written by every path that
// can change an occurrence's coaches (including ones added later), and a
// column with readers and a missed writer ships inert (rule 30). A derived
// fact cannot drift from the thing it is derived from (rule 52).
//
// ── WHAT THIS DELIBERATELY DOES NOT DECIDE ────────────────────────────────
// Only COACHES. A per-occurrence TIME or NOTE is still overwritten by a
// series edit, and that is left alone on purpose rather than by oversight:
// "the series moved to 8 AM, but this one date was hand-moved to 10 AM" has
// no obviously-correct answer, and guessing at one would also drag the
// occupancy pre-validation (`assertResourcesFree`) onto times this module
// invented. Coaches have an unambiguous answer, are what was reported, and
// are what the accountability engine reads. ▶ MAINTENANCE-HANDOFF open item.
//
// ── THE ESCAPE HATCH ──────────────────────────────────────────────────────
// `applyCoachesToAll` restores the old clobbering behavior for one submit,
// because "actually, put Mike on EVERY date, including the ones I fiddled
// with" is a real thing an operator wants and there would otherwise be no way
// to say it. It is opt-in per save, never sticky: a preserved date is an
// exception a human made, so only a human may end it (rule 38 / rule 52 —
// an exception must never expire on its own, and must always have a way out).

import { formatPfaDate } from "@/lib/timezone";

/**
 * One future occurrence as it exists RIGHT NOW, before the regenerate
 * destroys it.
 *
 * `coachIds` is PRIMARY-FIRST. `program_schedule_block_coaches` has no
 * ordering column, so the caller reconstructs the order from the block's own
 * `scheduled_coach_id` — preserving a set but losing which member was primary
 * would quietly reassign the block's headline coach, which is most of what
 * the operator sees on the tile.
 */
export type ExistingOccurrence = {
  startAt: Date;
  coachIds: string[];
};

export type PlannedOccurrence = {
  /** PFA calendar date, "YYYY-MM-DD". */
  pfaDate: string;
  /** Primary-first, exactly as it should be written. */
  coachIds: string[];
  /** True when this date kept its own coaches instead of the series' set. */
  preserved: boolean;
};

export type OccurrenceCoachPlan = {
  /** One entry per input occurrence, in the same order. */
  assignments: PlannedOccurrence[];
  /** How many dates kept their own coaches. */
  preservedCount: number;
  /** Those dates, ascending — for the audit row and the operator message. */
  preservedDates: string[];
};

/**
 * Order- and duplicate-insensitive set equality over coach ids.
 *
 * Deliberately NOT a length check plus `includes`: `["a","a"]` vs `["a","b"]`
 * have equal length and every member of the first is present in the second,
 * which is exactly the shape that returns a confident wrong answer. Comparing
 * DEDUPED sizes first cannot do that.
 *
 * Compares Sets rather than joined string keys on purpose: a joined key needs
 * a separator no id can contain, and that is a question worth not having.
 */
export function sameCoachSet(a: string[], b: string[]): boolean {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const id of setA) if (!setB.has(id)) return false;
  return true;
}

/**
 * Decide who lands on each regenerated occurrence.
 *
 * Pure: no database, no clock. The caller supplies the occurrences the new
 * definition generated, the occurrences that are about to be deleted, and
 * both versions of the series coach set.
 *
 * 📌 Occurrences are matched to existing blocks by PFA CALENDAR DATE, never by
 * timestamp. A series edit that changes the wall-clock window moves every
 * occurrence's `startAt`, so matching on the instant would find nothing and
 * silently preserve nothing — the failure mode being a fix that looks like it
 * works until the day somebody also changes the time. A weekly/monthly series
 * generates at most one occurrence per date, so the date is a sound key.
 */
export function planOccurrenceCoaches(input: {
  occurrences: readonly { startAt: Date }[];
  existing: readonly ExistingOccurrence[];
  previousSeriesCoachIds: readonly string[];
  nextSeriesCoachIds: readonly string[];
  applyCoachesToAll: boolean;
}): OccurrenceCoachPlan {
  const {
    occurrences,
    existing,
    previousSeriesCoachIds,
    nextSeriesCoachIds,
    applyCoachesToAll,
  } = input;

  const nextSet = [...nextSeriesCoachIds];
  const previousSet = [...previousSeriesCoachIds];

  // Last writer wins on a duplicate date. A weekly/monthly series cannot
  // generate two occurrences on one date, so this is only reachable from
  // pre-existing duplicate block rows; picking one is better than throwing
  // inside a regenerate that has already deleted the schedule.
  const byDate = new Map<string, ExistingOccurrence>();
  for (const occ of existing) {
    byDate.set(formatPfaDate(occ.startAt), occ);
  }

  const assignments: PlannedOccurrence[] = [];
  const preservedDates: string[] = [];

  for (const occ of occurrences) {
    const pfaDate = formatPfaDate(occ.startAt);
    const current = byDate.get(pfaDate);

    const individuallyAssigned =
      current !== undefined && !sameCoachSet(current.coachIds, previousSet);

    if (!applyCoachesToAll && individuallyAssigned) {
      assignments.push({
        pfaDate,
        coachIds: [...current.coachIds],
        preserved: true,
      });
      preservedDates.push(pfaDate);
      continue;
    }

    assignments.push({ pfaDate, coachIds: [...nextSet], preserved: false });
  }

  preservedDates.sort();
  return {
    assignments,
    preservedCount: preservedDates.length,
    preservedDates,
  };
}
