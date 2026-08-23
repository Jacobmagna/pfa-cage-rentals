// stipend SPEC §15.1 — THE ONE-TIME, IDEMPOTENT SEPT-1 BACKFILL.
//
// ── Why this exists ──────────────────────────────────────────────────────
// Mark wants stipends "starting September 1, 2026." Shipping a live money
// surface by then is not realistic and is not being attempted. It does not
// have to be: `effective_from = 2026-09-01` is a property of the DATA, not of
// the ship date, and the app is already recording hour logs normally. So a
// feature that goes live on, say, Sept 22 can still pay September correctly —
// PROVIDED the earnings for periods that already elapsed get created when it
// ships.
//
// 🔴 WITHOUT THIS, EVERY HOUR LOGGED BETWEEN SEPT 1 AND SHIP DATE SILENTLY
// PAYS NOTHING. Not an error, not a warning — a coach simply is not paid for
// a half-month they worked, and the only evidence is an absence.
//
// ── It writes through the LIVE TRIGGER, deliberately ─────────────────────
// This module finds the (coach, period) pairs that should have earned and
// then calls `recordStipendEarning` — the exact function the three posted
// moments call. It does NOT have its own insert.
//
// That is the whole design. §15.1 requires the backfill to write "the
// earnings that the live trigger would have written"; routing both through one
// function makes that true BY CONSTRUCTION rather than by a comment claiming
// two code paths agree. The 2026-08-13 sweep's central lesson was *"same
// function is not the same inputs"* — here it is the same function AND the
// same inputs, and the amount resolver is passed in from the same place.
//
// ── Idempotent, so re-running is boring ──────────────────────────────────
// `UNIQUE (coach_id, period_key)` means a second run creates nothing and
// reports every pair as `already_earned`. Run it as many times as you like;
// run it again after the deploy; run it if you are unsure whether it ran.
//
// ── 🔴 THE FLOOR IS NOT A PARAMETER YOU MAY LOWER ────────────────────────
// §15.1: "This is the ONLY sanctioned backfill. It creates no earning before
// 2026-09-01, which is what keeps §12.4's back-pay discontinuity from firing."
// Backdating further would make `/admin/payments` claim months of back-pay
// that Mark may already have settled in cash — the app has no payout ledger
// for work pay, and the standing rule is to ask him before any such move.
// `SANCTIONED_FLOOR` is enforced here, in code, not left to the caller.

import { and, asc, eq, gte } from "drizzle-orm";
import { db } from "@/db";
import { hourLogs } from "@/db/schema";
import { isPayPeriodStart, payPeriodFor, type PayPeriod } from "@/lib/pay-period";
import { pfaWallClockToUtc } from "@/lib/timezone";
import { recordStipendEarning, type StipendEarningOutcome } from "./earnings";

/**
 * PFA-midnight on 2026-09-01 — Mark's answer to Q9, and the earliest instant
 * this backfill will consider. Built through `pfaWallClockToUtc` rather than
 * written as a `Z` literal so it stays right regardless of DST and of the
 * runtime's own zone.
 */
export const SANCTIONED_FLOOR = pfaWallClockToUtc("2026-09-01", "00:00");

export type BackfillCandidate = {
  coachId: string;
  period: PayPeriod;
  /** The EARLIEST posted covered log in that period — the one credited. */
  hourLogId: string;
  logStartAt: Date;
  /** How many posted covered logs the coach has in the period. R4: all earn one. */
  logCount: number;
};

export type BackfillReport = {
  fromDate: Date;
  applied: boolean;
  candidates: BackfillCandidate[];
  /** Present only when `apply` was true. Indexed alike to `candidates`. */
  outcomes: StipendEarningOutcome[];
  counts: {
    coveredLogsScanned: number;
    candidatePairs: number;
    earned: number;
    alreadyEarned: number;
    notApplicable: number;
    failed: number;
  };
};

export class StipendBackfillFloorError extends Error {
  constructor(fromDate: Date) {
    super(
      `REFUSING: ${fromDate.toISOString()} is before the sanctioned floor ` +
        `${SANCTIONED_FLOOR.toISOString()} (2026-09-01 PFA). SPEC §15.1 allows ` +
        `exactly one backfill and it creates no earning before that date — ` +
        `backdating further would claim back-pay Mark may already have settled in cash.`,
    );
    this.name = "StipendBackfillFloorError";
  }
}

/**
 * Find the (coach, pay period) pairs that a posted, stipend-covered hour log
 * should already have earned, and — when `apply` is true — write them.
 *
 * @param apply false (the default) reads and reports only. NOTHING is written.
 * @param resolveAmountCents the same resolver the live trigger uses; passed in
 *   rather than imported so this module does not depend on
 *   `hour-log-actions.ts` (which imports the earnings module).
 */
export async function backfillStipendEarnings(input: {
  actorUserId: string;
  resolveAmountCents: (coachId: string, at: Date) => Promise<number | null>;
  fromDate?: Date;
  apply?: boolean;
}): Promise<BackfillReport> {
  const fromDate = input.fromDate ?? SANCTIONED_FLOOR;
  const apply = input.apply === true;

  // 🔴 The floor, before anything is read or written.
  if (fromDate.getTime() < SANCTIONED_FLOOR.getTime()) {
    throw new StipendBackfillFloorError(fromDate);
  }
  if (!isPayPeriodStart(fromDate)) {
    throw new Error(
      `REFUSING: ${fromDate.toISOString()} is not the start of a pay period. ` +
        "Starting mid-period would earn a whole stipend for a partial one.",
    );
  }

  // Posted + covered + at-or-after the floor. `asc(startAt)` matters: the
  // FIRST log in each period becomes `earned_by_hour_log_id`, so a re-run
  // credits the same log and the report reads the same way twice.
  const rows = await db
    .select({
      id: hourLogs.id,
      coachId: hourLogs.coachId,
      startAt: hourLogs.startAt,
    })
    .from(hourLogs)
    .where(
      and(
        eq(hourLogs.status, "posted"),
        eq(hourLogs.stipendCovered, true),
        gte(hourLogs.startAt, fromDate),
      ),
    )
    .orderBy(asc(hourLogs.startAt));

  // Collapse to one candidate per (coach, period). This IS Mark's R4 — one
  // logged hour and forty in a period earn the same single stipend — applied
  // before any write rather than relying on the unique index to absorb 39
  // redundant inserts.
  const byPair = new Map<string, BackfillCandidate>();
  for (const row of rows) {
    const period = payPeriodFor(row.startAt);
    const key = `${row.coachId}::${period.key}`;
    const seen = byPair.get(key);
    if (seen) {
      seen.logCount += 1;
      continue;
    }
    byPair.set(key, {
      coachId: row.coachId,
      period,
      hourLogId: row.id,
      logStartAt: row.startAt,
      logCount: 1,
    });
  }
  const candidates = [...byPair.values()].sort(
    (a, b) =>
      a.period.fromDate.getTime() - b.period.fromDate.getTime() ||
      a.coachId.localeCompare(b.coachId),
  );

  const counts: BackfillReport["counts"] = {
    coveredLogsScanned: rows.length,
    candidatePairs: candidates.length,
    earned: 0,
    alreadyEarned: 0,
    notApplicable: 0,
    failed: 0,
  };

  if (!apply) {
    return { fromDate, applied: false, candidates, outcomes: [], counts };
  }

  const outcomes: StipendEarningOutcome[] = [];
  // Sequential on purpose. This runs once, over tens of rows, against a
  // half-month's payroll — there is nothing to gain from concurrency and a
  // deterministic order makes the report readable next to the table.
  for (const c of candidates) {
    const outcome = await recordStipendEarning({
      actorUserId: input.actorUserId,
      coachId: c.coachId,
      hourLogId: c.hourLogId,
      logStartAt: c.logStartAt,
      // Every candidate came from a `stipend_covered = true` row; the flag is
      // passed rather than hardcoded so this call reads identically to the
      // three live ones.
      stipendCovered: true,
      resolveAmountCents: input.resolveAmountCents,
    });
    outcomes.push(outcome);
    if (outcome.status === "earned") counts.earned += 1;
    else if (outcome.status === "already_earned") counts.alreadyEarned += 1;
    else if (outcome.status === "failed") counts.failed += 1;
    else counts.notApplicable += 1;
  }

  return { fromDate, applied: true, candidates, outcomes, counts };
}
