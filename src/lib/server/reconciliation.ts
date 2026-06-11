// Pure schedule-reconciliation engine (FEAT-16, SCR-1b + DEC-29 + DEC-30).
// No DB, no React, no I/O — and no `Date.now()` / argless `new Date()`
// inside it: callers inject `now` and a `formatTime` formatter so the
// logic is deterministic and unit-testable. Mirrors the pure-function +
// unit-test pattern of src/lib/server/attendance-flags.ts.
//
// It compares what the admin SCHEDULED (program_schedule_blocks, FEAT-15)
// against what coaches actually LOGGED (hour_logs, FEAT-05/06) and
// surfaces the mismatch two ways:
//   - reconcileBlocks: blockId → {status, detail} — colors the
//     Programs-schedule grid bars + the click-to-edit detail.
//   - annotateLogs:    logId → scheduleNote | null — the "Schedule" note
//     on the admin Hour Log table + Excel Detail sheet.
//
// Settled rules implemented exactly (DEC-29 "within ~15 min", SCR-1b):
//  - TOLERANCE_MS = ±15 min: a logged window matches a block when both
//    its start AND end are within tolerance of the block's.
//  - NO_SHOW_BUFFER_MS = 1 hr: a block with no overlapping log only
//    becomes a no-show once `now` is past its end + this buffer;
//    before that it's still "pending".
//  - Precedence (highest first): logged > wrong_time > wrong_coach >
//    no_show/pending. The scheduled coach's own log always wins over
//    another coach's overlapping log.

import { isOverLogged } from "@/lib/accountability";

const TOLERANCE_MS = 15 * 60_000; // ±15 min — DEC-29 "within ~15 min"
const NO_SHOW_BUFFER_MS = 60 * 60_000; // 1 hr buffer — SCR-1b

// QA10 W3.2: a scheduled coach on a block. A block can have several.
export type ReconCoach = { coachId: string; coachName: string };

export type ReconBlock = {
  id: string;
  programId: string;
  // QA-R2 #10: coach is OPTIONAL — null when the block is Unassigned.
  scheduledCoachId: string | null; // primary (first) — keep for back-compat
  scheduledCoachName: string | null; // primary — keep
  coaches: ReconCoach[]; // FULL set; EMPTY when the block has no coach
  startAt: Date;
  endAt: Date;
};

export type ReconLog = {
  coachId: string;
  coachName: string;
  programId: string;
  startAt: Date;
  endAt: Date;
};

export type BlockStatus =
  | "logged"
  | "wrong_coach"
  | "wrong_time"
  | "no_show"
  | "pending";

// QA10 W3.2: per-scheduled-coach reconciliation result.
export type CoachReconciliation = {
  coachId: string;
  coachName: string;
  status: BlockStatus;
  detail: string;
};

export type BlockReconciliation = {
  status: BlockStatus; // AGGREGATE — colors the grid bar
  detail: string; // aggregate detail (see rule)
  coaches: CoachReconciliation[]; // one per scheduled coach, block.coaches order
};

// QA10 W3.2: block-level aggregate precedence — the bar is red if ANY
// coach has a problem, gold if any pending, green only when ALL logged.
// (Distinct from the single-coach precedence inside the per-coach pass.)
const AGGREGATE_ORDER: BlockStatus[] = [
  "no_show",
  "wrong_time",
  "wrong_coach",
  "pending",
  "logged",
];

/**
 * Two half-open intervals overlap when each starts before the other ends.
 */
function overlaps(
  aStart: Date,
  aEnd: Date,
  bStart: Date,
  bEnd: Date,
): boolean {
  return (
    aStart.getTime() < bEnd.getTime() && aEnd.getTime() > bStart.getTime()
  );
}

/**
 * A logged window matches a block within tolerance when BOTH ends are
 * within ±TOLERANCE_MS of the block's.
 */
function withinTol(
  log: { startAt: Date; endAt: Date },
  block: { startAt: Date; endAt: Date },
): boolean {
  return (
    Math.abs(log.startAt.getTime() - block.startAt.getTime()) <=
      TOLERANCE_MS &&
    Math.abs(log.endAt.getTime() - block.endAt.getTime()) <= TOLERANCE_MS
  );
}

/**
 * Deterministic ascending sort by startAt, tie-broken by coachId.
 */
function byStartThenCoach(a: ReconLog, b: ReconLog): number {
  return (
    a.startAt.getTime() - b.startAt.getTime() ||
    a.coachId.localeCompare(b.coachId)
  );
}

/**
 * Reconciles each scheduled block against the coach hour-logs. Returns
 * blockId → {status, detail}. See module header for the precedence rules.
 */
export function reconcileBlocks(
  input: { blocks: ReconBlock[]; logs: ReconLog[]; now: Date },
  formatTime: (d: Date) => string,
): Record<string, BlockReconciliation> {
  const { blocks, logs, now } = input;
  const result: Record<string, BlockReconciliation> = {};

  for (const b of blocks) {
    // The full set of scheduled coaches on this block. `otherLogs`
    // (drives wrong_coach) is "logged by someone NOT scheduled here", so
    // a different scheduled coach's log never counts as a wrong_coach for
    // anyone. Build the membership set once per block.
    const coachIdSet = new Set(b.coaches.map((c) => c.coachId));

    const overlapping = logs.filter(
      (log) =>
        log.programId === b.programId &&
        overlaps(log.startAt, log.endAt, b.startAt, b.endAt),
    );

    // Per-coach pass — reuse the existing single-coach precedence
    // (logged > wrong_time > wrong_coach > no_show/pending) with this
    // coach as `s` and the two membership-aware predicate changes.
    const coachResults: CoachReconciliation[] = b.coaches.map((c) => {
      const s = c.coachName;
      const sLogs = overlapping
        .filter((log) => log.coachId === c.coachId)
        .sort(byStartThenCoach);
      const otherLogs = overlapping
        .filter((log) => !coachIdSet.has(log.coachId))
        .sort(byStartThenCoach);

      // 1. logged — this coach logged a window within tolerance.
      const m = sLogs.find((log) => withinTol(log, b));
      if (m) {
        return {
          coachId: c.coachId,
          coachName: c.coachName,
          status: "logged",
          detail: `On schedule — ${s} logged ${formatTime(m.startAt)}–${formatTime(m.endAt)}.`,
        };
      }

      // 2. wrong_time — this coach overlapped but none in tolerance.
      if (sLogs.length > 0) {
        const x = sLogs[0];
        return {
          coachId: c.coachId,
          coachName: c.coachName,
          status: "wrong_time",
          detail: `${s} logged ${formatTime(x.startAt)}–${formatTime(x.endAt)} instead of the scheduled ${formatTime(b.startAt)}–${formatTime(b.endAt)}.`,
        };
      }

      // 3. wrong_coach — only an UNSCHEDULED coach overlapped.
      if (otherLogs.length > 0) {
        const o = otherLogs[0];
        return {
          coachId: c.coachId,
          coachName: c.coachName,
          status: "wrong_coach",
          detail: `${o.coachName} logged ${formatTime(o.startAt)}–${formatTime(o.endAt)} instead of ${s}.`,
        };
      }

      // 4. no overlapping log → no_show (past end + buffer) or pending.
      if (now.getTime() >= b.endAt.getTime() + NO_SHOW_BUFFER_MS) {
        return {
          coachId: c.coachId,
          coachName: c.coachName,
          status: "no_show",
          detail: `${s} didn't log anything for this block.`,
        };
      }
      return {
        coachId: c.coachId,
        coachName: c.coachName,
        status: "pending",
        detail: "Scheduled window hasn't closed yet.",
      };
    });

    // Block-level aggregate. status = highest-precedence present across
    // the per-coach statuses (no_show > wrong_time > wrong_coach >
    // pending > logged), so the bar is red if ANY coach has a problem,
    // gold if any pending, green only when ALL logged. With exactly one
    // coach this equals that coach's status (back-compat).
    const aggStatus =
      AGGREGATE_ORDER.find((status) =>
        coachResults.some((c) => c.status === status),
      ) ?? "logged";

    // detail: single coach → byte-identical to today's wording. Multiple
    // coaches → "<name>: <detail>" joined by "  ·  ".
    const aggDetail =
      coachResults.length === 1
        ? coachResults[0].detail
        : coachResults
            .map((c) => `${c.coachName}: ${c.detail}`)
            .join("  ·  ");

    result[b.id] = {
      status: aggStatus,
      detail: aggDetail,
      coaches: coachResults,
    };
  }

  return result;
}

/**
 * Match ONE scheduled block to a log, deterministically — the single
 * source of truth for "which block did this log belong to". Returns null
 * when no block of the same program overlaps the log (an unscheduled /
 * ad-hoc log). Choice order:
 *   1. a block the coach is IN-SET on AND within tolerance, else
 *   2. a block the coach is in-set on, else
 *   3. the first overlapping block by startAt (tie-break id).
 * Both `annotateLogs` (schedule notes) and the accountability scorecard's
 * over-logged check call this so the matching lives in exactly one place.
 */
export function matchLogToBlock(
  log: { coachId: string; programId: string; startAt: Date; endAt: Date },
  blocks: ReconBlock[],
): ReconBlock | null {
  const candidates = blocks.filter(
    (block) =>
      block.programId === log.programId &&
      overlaps(log.startAt, log.endAt, block.startAt, block.endAt),
  );
  if (candidates.length === 0) return null;

  const sorted = [...candidates].sort(
    (a, b) =>
      a.startAt.getTime() - b.startAt.getTime() || a.id.localeCompare(b.id),
  );
  // QA10 W3.2: same-coach means "this coach is in the block's scheduled
  // coach SET" (not just the primary).
  const inSet = (block: ReconBlock) =>
    block.coaches.some((bc) => bc.coachId === log.coachId);
  return (
    sorted.find((block) => inSet(block) && withinTol(log, block)) ??
    sorted.find((block) => inSet(block)) ??
    sorted[0]
  );
}

/**
 * Annotates each hour-log with a "Schedule" note describing how it
 * differs from what was scheduled. Returns logId → note | null, where
 * null means "no mismatch worth noting" (on-schedule or unscheduled).
 */
export function annotateLogs(
  input: { logs: (ReconLog & { id: string })[]; blocks: ReconBlock[] },
  formatTime: (d: Date) => string,
): Record<string, string | null> {
  const { logs, blocks } = input;
  const result: Record<string, string | null> = {};

  for (const l of logs) {
    const c = l.coachId;

    const chosen = matchLogToBlock(l, blocks);

    if (chosen === null) {
      // Unscheduled / ad-hoc log — nothing to say.
      result[l.id] = null;
      continue;
    }

    // QA10 W3.2: same-coach means "this coach is in the block's
    // scheduled-coach SET" (not just the primary).
    const inSet = (block: ReconBlock) =>
      block.coaches.some((bc) => bc.coachId === c);

    if (inSet(chosen) && withinTol(l, chosen)) {
      // On schedule — no note.
      result[l.id] = null;
    } else if (!inSet(chosen)) {
      // The coach who logged isn't scheduled on the chosen block — name
      // the scheduled coach(es). QA-R2 #10: a coachless block has no
      // scheduled coach to name.
      result[l.id] =
        chosen.coaches.length === 0
          ? "No coach was scheduled."
          : chosen.coaches.length === 1
            ? `${chosen.scheduledCoachName} was scheduled.`
            : `${chosen.coaches.map((bc) => bc.coachName).join(", ")} were scheduled.`;
    } else {
      // In set, off-time.
      result[l.id] = `Scheduled ${formatTime(chosen.startAt)}–${formatTime(chosen.endAt)}.`;
    }
  }

  return result;
}

// 1b security B: the manual-log anomaly verdict. "clean" posts normally;
// the other three are HELD-for-approval kinds, each carrying a coach-facing
// message naming the specific issue (`heldReason` stores the kind).
export type ManualLogAnomaly =
  | { kind: "clean" }
  | { kind: "unscheduled"; message: string }
  | { kind: "wrong_time"; message: string }
  | { kind: "over_logged"; message: string };

/**
 * Classifies ONE manual hour-log against the scheduled blocks the logging
 * coach is a MEMBER of (all passed `blocks` already have the coach in-set,
 * so in-set checks are implicit). Pure + deterministic — no DB, no `now`.
 * Reuses matchLogToBlock (the single source of truth for "which block did
 * this log belong to"), withinTol (±15 on both ends), and isOverLogged
 * (logged > scheduled by > the 30-min margin) so the held-then-approve gate
 * agrees with the reconciliation overlay + the accountability scorecard.
 */
export function classifyManualLog(
  log: { coachId: string; programId: string; startAt: Date; endAt: Date },
  blocks: ReconBlock[],
  formatTime: (d: Date) => string,
): ManualLogAnomaly {
  const match = matchLogToBlock(log, blocks);

  // No same-program block overlaps the log window — ad-hoc / off-schedule.
  if (match === null) {
    return {
      kind: "unscheduled",
      message: "This time isn't on your work schedule.",
    };
  }

  // Within ±15 on both ends ⇒ the over-log can be at most 30 min ⇒ never
  // over-logged here, so this clean check comes first.
  if (withinTol(log, match)) {
    return { kind: "clean" };
  }

  // Off-time AND logged materially longer than the block → over-logged.
  if (isOverLogged(log.startAt, log.endAt, match.startAt, match.endAt)) {
    return {
      kind: "over_logged",
      message: `You logged longer than the scheduled block (${formatTime(match.startAt)}–${formatTime(match.endAt)}).`,
    };
  }

  // Overlaps a block but the times are off by more than tolerance.
  return {
    kind: "wrong_time",
    message: `That doesn't match your scheduled block (${formatTime(match.startAt)}–${formatTime(match.endAt)}).`,
  };
}
