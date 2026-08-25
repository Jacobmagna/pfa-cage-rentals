// stipend SPEC §4.3 / §15 Phase B4 — THE EARNING TRIGGER.
//
// One function, called from every place an hour log becomes POSTED. It is the
// only thing in the codebase that writes `coach_stipend_earnings`.
//
// ── The trigger, stated exactly (SPEC §17, which governs) ──────────────────
// "An hour log becomes POSTED, on a stipend-covered program, for a coach who
// had a stipend amount in effect for that log's pay period."
//
// NOT "scheduled". Mark answered the final two questions himself: a block that
// is scheduled but never logged earns nothing, and a HELD log earns nothing
// until it is approved. That answer is the single largest risk reduction in
// this design — it collapsed five schedule-mutation write paths across four
// files down to the three posted-moments in one file, and it took
// `block-handoff-actions.ts` (the flagged "sleeper" that could silently move a
// coach's stipend) out of scope entirely.
//
// ── 🔴 THE FIVE POSTED MOMENTS ───────────────────────────────────────────
// All five are in `hour-log-actions.ts`, and MISSING ONE MEANS A COACH IS
// SILENTLY NOT PAID:
//   1. `writeHourLogInternal` — the INSERT, when the log is clean and takes
//      the schema's `posted` default.
//   2. `writeHourLogInternal` — the HELD → POSTED upgrade on conflict, when a
//      write carrying approval authority arrives for a window already held.
//   3. `approveHeldHourLogInternal` — an admin approving a held log.
//   4. `updateHourInternal` — a time EDIT can move a posted log into a
//      different pay period, and an edit is not a post.
//   5. `acceptNeedsReviewLogInternal` — same, via the accept-with-correction
//      path. (4) and (5) were added by the §14.7 adversarial review.
// ⚠️ (2) is easy to miss reading the file: it is an UPDATE inside the
// duplicate-conflict branch of the INSERT path, a long way from either of the
// other two. The census that found it: one `insert(hourLogs)` site in `src`,
// and exactly two literal `status: "posted"` writers.
//
// 📌 AN ADMIN RECORDING HOURS FOR A COACH ADDED NO SIXTH MOMENT, and that is
// worth stating because the obvious expectation is that it would. It is a new
// posted moment in the business sense, but not a new CALL SITE: it runs
// `writeHourLogInternal`, so it earns through (1) and (2) above. There was
// nothing to remember, and so nowhere for it to be forgotten. A second insert
// path written alongside the first is the shape that would have needed a
// sixth call — which is the argument for the shared core, stated in money.
//
// ── Idempotent by DATABASE CONSTRAINT, not by application logic ───────────
// `UNIQUE (coach_id, period_key)` turns "one logged hour and forty logged
// hours in a period earn the SAME single stipend" (Mark's R4) into something
// Postgres enforces. That makes this an `onConflictDoNothing` upsert, makes
// calling it from three places safe, and is also what makes the Sept-1
// backfill re-runnable.
//
// ── What this function must NEVER do ─────────────────────────────────────
// 🔴 It never throws into the caller's path. A log posting is the coach's
// work being recorded; a stipend earning is a downstream consequence. If the
// earning write fails, the log must still post — the failure goes to Sentry
// and the backfill (which is idempotent and re-runnable) is the recovery.
// Inverting that would let a stipend bug block a coach from logging hours.
//
// 🔴 It never REMOVES an earning. Mark's Q3: the stipend stands even if the
// block is deleted. Rejecting, deleting or un-approving a log does not call
// into this module, and the FK is ON DELETE SET NULL rather than CASCADE so
// the database cannot do it either. Mark voids by hand.

import * as Sentry from "@sentry/nextjs";
import { db } from "@/db";
import { coachStipendEarnings } from "@/db/schema";
import { payPeriodFor } from "@/lib/pay-period";
import { safeLogAudit } from "@/lib/server/audit-helpers";

/** The audit `entityType` for an earned stipend. One spelling, grep-able. */
export const STIPEND_EARNING_ENTITY_TYPE = "coach_stipend_earning" as const;

export type StipendEarningOutcome =
  /** The log is not stipend-covered, or the coach had no amount for the period. */
  | { status: "not_applicable" }
  /** A stipend for this (coach, period) already existed. R4 — one per period. */
  | { status: "already_earned"; periodKey: string }
  | { status: "earned"; periodKey: string; earningId: string; amountCents: number }
  /** The write failed. The log still posted; Sentry has it; the backfill recovers it. */
  | { status: "failed"; periodKey: string };

/**
 * Record the stipend earned by an hour log that has just become POSTED.
 *
 * @param stipendCovered the LOG'S OWN `stipend_covered` snapshot — never
 *   re-derived here. The snapshot was resolved when the log was written, and
 *   re-asking the question at approval time would let a program's coverage
 *   flag flipping in between change what an already-logged hour is worth.
 * @param logStartAt 🔴 the LOG's own start instant, which is what buckets the
 *   earning. Approving a September log in October must earn a SEPTEMBER
 *   stipend; using the approval date would file it in the wrong half-month and
 *   pay the wrong period.
 * @param resolveAmountCents injected so the caller supplies the already-loaded
 *   resolver (`fetchStipendAmountCentsForPeriod`) rather than this module
 *   importing `hour-log-actions.ts` and creating a cycle.
 */
export async function recordStipendEarning(input: {
  actorUserId: string;
  coachId: string;
  hourLogId: string;
  logStartAt: Date;
  stipendCovered: boolean;
  resolveAmountCents: (coachId: string, at: Date) => Promise<number | null>;
}): Promise<StipendEarningOutcome> {
  const { actorUserId, coachId, hourLogId, logStartAt, stipendCovered } = input;

  if (!stipendCovered) return { status: "not_applicable" };

  const period = payPeriodFor(logStartAt);

  try {
    // Resolved against the PERIOD's start, not "now" and not the log's own
    // instant — the version in force at the period's first moment is the one
    // that governs the whole half-month (Q5).
    const amountCents = await input.resolveAmountCents(coachId, logStartAt);

    // Defensive, and reachable: a log can be inserted HELD while the coach is
    // on a stipend and approved after the stipend was ended with a confirmed
    // retroactive end. The snapshot still says covered; the amount is gone.
    // Earning nothing is the right answer — an earning with no amount behind
    // it would be a number invented at approval time.
    if (amountCents == null) return { status: "not_applicable" };

    const inserted = await db
      .insert(coachStipendEarnings)
      .values({
        coachId,
        periodKey: period.key,
        periodStart: period.fromDate,
        amountCents,
        earnedByHourLogId: hourLogId,
      })
      .onConflictDoNothing({
        target: [coachStipendEarnings.coachId, coachStipendEarnings.periodKey],
      })
      .returning();

    const row = inserted[0];
    // An EMPTY array is the R4 case, not an error: this coach already earned
    // this period. Forty logs in a half-month land here thirty-nine times.
    if (!row) return { status: "already_earned", periodKey: period.key };

    await safeLogAudit(db, {
      actorUserId,
      entityType: STIPEND_EARNING_ENTITY_TYPE,
      entityId: row.id,
      action: "create",
      after: {
        coachId,
        periodKey: row.periodKey,
        periodStart: row.periodStart,
        amountCents: row.amountCents,
        earnedByHourLogId: row.earnedByHourLogId,
      } as unknown as Record<string, unknown>,
    });

    return {
      status: "earned",
      periodKey: period.key,
      earningId: row.id,
      amountCents: row.amountCents,
    };
  } catch (err) {
    // 🔴 SWALLOWED ON PURPOSE — see the module note. The hour log has already
    // been written by the time this runs; throwing here would surface a
    // stipend-bookkeeping failure to a coach as "your hours didn't save".
    Sentry.captureException(err, {
      tags: { component: "stipend-earning", periodKey: period.key },
      extra: { coachId, hourLogId, logStartAt: logStartAt.toISOString() },
    });
    console.error("[stipend] earning insert failed:", err);
    return { status: "failed", periodKey: period.key };
  }
}
