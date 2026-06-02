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

const TOLERANCE_MS = 15 * 60_000; // ±15 min — DEC-29 "within ~15 min"
const NO_SHOW_BUFFER_MS = 60 * 60_000; // 1 hr buffer — SCR-1b

export type ReconBlock = {
  id: string;
  programId: string;
  scheduledCoachId: string;
  scheduledCoachName: string;
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

export type BlockReconciliation = { status: BlockStatus; detail: string };

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
    const s = b.scheduledCoachName;

    const overlapping = logs.filter(
      (log) =>
        log.programId === b.programId &&
        overlaps(log.startAt, log.endAt, b.startAt, b.endAt),
    );
    const sLogs = overlapping
      .filter((log) => log.coachId === b.scheduledCoachId)
      .sort(byStartThenCoach);
    const otherLogs = overlapping
      .filter((log) => log.coachId !== b.scheduledCoachId)
      .sort(byStartThenCoach);

    // 1. logged — scheduled coach logged a window within tolerance.
    const m = sLogs.find((log) => withinTol(log, b));
    if (m) {
      result[b.id] = {
        status: "logged",
        detail: `On schedule — ${s} logged ${formatTime(m.startAt)}–${formatTime(m.endAt)}.`,
      };
      continue;
    }

    // 2. wrong_time — scheduled coach overlapped but none in tolerance.
    if (sLogs.length > 0) {
      const x = sLogs[0];
      result[b.id] = {
        status: "wrong_time",
        detail: `${s} logged ${formatTime(x.startAt)}–${formatTime(x.endAt)} instead of the scheduled ${formatTime(b.startAt)}–${formatTime(b.endAt)}.`,
      };
      continue;
    }

    // 3. wrong_coach — only another coach overlapped.
    if (otherLogs.length > 0) {
      const o = otherLogs[0];
      result[b.id] = {
        status: "wrong_coach",
        detail: `${o.coachName} logged ${formatTime(o.startAt)}–${formatTime(o.endAt)} instead of ${s}.`,
      };
      continue;
    }

    // 4. no overlapping log at all → no_show (past end + buffer) or pending.
    if (now.getTime() >= b.endAt.getTime() + NO_SHOW_BUFFER_MS) {
      result[b.id] = {
        status: "no_show",
        detail: `${s} didn't log anything for this block.`,
      };
    } else {
      result[b.id] = {
        status: "pending",
        detail: "Scheduled window hasn't closed yet.",
      };
    }
  }

  return result;
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

    const candidates = blocks.filter(
      (block) =>
        block.programId === l.programId &&
        overlaps(l.startAt, l.endAt, block.startAt, block.endAt),
    );

    if (candidates.length === 0) {
      // Unscheduled / ad-hoc log — nothing to say.
      result[l.id] = null;
      continue;
    }

    // Choose ONE block deterministically:
    //   1. same coach AND within tolerance, else
    //   2. same coach, else
    //   3. the first by startAt (tie-break id).
    const sorted = [...candidates].sort(
      (a, b) =>
        a.startAt.getTime() - b.startAt.getTime() || a.id.localeCompare(b.id),
    );
    const chosen =
      sorted.find(
        (block) => block.scheduledCoachId === c && withinTol(l, block),
      ) ??
      sorted.find((block) => block.scheduledCoachId === c) ??
      sorted[0];

    if (chosen.scheduledCoachId === c && withinTol(l, chosen)) {
      // On schedule — no note.
      result[l.id] = null;
    } else if (chosen.scheduledCoachId !== c) {
      result[l.id] = `${chosen.scheduledCoachName} was scheduled.`;
    } else {
      // Same coach, off-time.
      result[l.id] = `Scheduled ${formatTime(chosen.startAt)}–${formatTime(chosen.endAt)}.`;
    }
  }

  return result;
}
