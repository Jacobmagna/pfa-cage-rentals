import { Clock } from "lucide-react";
import { and, asc, eq, gte, isNull, lte, ne } from "drizzle-orm";
import { db } from "@/db";
import {
  hourLogs,
  programBlockCoachFlags,
  programs,
  programScheduleBlockCoaches,
  programScheduleBlocks,
  users,
} from "@/db/schema";
import { requireSession } from "@/lib/authz";
import {
  isBlockConfirmable,
  isBlockOverdue,
  isLogScheduled,
} from "@/lib/coach-hour-log";
import {
  formatPfaDate,
  formatPfaDateMedium,
  formatPfaTime12h,
} from "@/lib/timezone";
import { HourLogForm } from "./_components/hour-log-form";
import {
  ScheduleConfirmList,
  type ConfirmableBlock,
} from "./_components/schedule-confirm-list";

// Coach hour-log "Log hours" tab (QA10 W3.7 + W3-polish15). Two stacked
// sections:
//   1. Confirm-the-schedule — the coach's scheduled program blocks that
//      have STARTED within the last 14 days and aren't yet logged or
//      cancelled. Each is one tap away from being logged; a block more
//      than 1 hr past its end is tagged "Overdue". They can also Cancel
//      a block that didn't happen.
//   2. The manual HourLogForm (unchanged), for any hours on or off the
//      schedule. The <h1> + sub-nav live in layout.tsx.
//
// DEC-29: coaches may log against ANY active program. Public server
// action `logOwnHour` enforces coachId = self regardless of any
// client-supplied value.

// Confirm-list lookback: the coach's started-but-not-future blocks from
// the last 14 days. Wide enough to surface anything they still owe; the
// per-row "Overdue" tag distinguishes stale ones.
const LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

export default async function CoachHourLogPage() {
  const session = await requireSession();
  const { user } = session;
  const coachId = user.id;

  const now = new Date();
  const nowMs = now.getTime();
  const windowStart = new Date(nowMs - LOOKBACK_MS);

  const [
    programOptions,
    candidateBlocks,
    recentLogs,
    cancelledFlags,
    coachRoster,
  ] = await Promise.all([
    db
      .select({ id: programs.id, name: programs.name })
      .from(programs)
      .where(eq(programs.active, true))
      .orderBy(programs.name),
    // Scheduled blocks for THIS coach (membership join, mirrors
    // coach/schedule) whose END falls in the query window.
    db
      .select({
        id: programScheduleBlocks.id,
        programId: programScheduleBlocks.programId,
        programName: programs.name,
        startAt: programScheduleBlocks.startAt,
        endAt: programScheduleBlocks.endAt,
      })
      .from(programScheduleBlocks)
      .innerJoin(programs, eq(programScheduleBlocks.programId, programs.id))
      .innerJoin(
        programScheduleBlockCoaches,
        eq(programScheduleBlockCoaches.blockId, programScheduleBlocks.id),
      )
      .where(
        and(
          eq(programScheduleBlockCoaches.coachId, coachId),
          gte(programScheduleBlocks.endAt, windowStart),
          lte(programScheduleBlocks.startAt, now),
        ),
      )
      .orderBy(asc(programScheduleBlocks.endAt)),
    // The coach's own hour-logs in the same span, used to drop any block
    // they've already logged (overlap + same program via isLogScheduled).
    db
      .select({
        programId: hourLogs.programId,
        startAt: hourLogs.startAt,
        endAt: hourLogs.endAt,
      })
      .from(hourLogs)
      .where(
        and(
          eq(hourLogs.coachId, coachId),
          gte(hourLogs.startAt, windowStart),
          lte(hourLogs.startAt, now),
        ),
      ),
    // This coach's 'cancelled' flags — blocks they've explicitly cancelled
    // are removed from the confirm list below (W3-polish15).
    db
      .select({ blockId: programBlockCoachFlags.blockId })
      .from(programBlockCoachFlags)
      .where(
        and(
          eq(programBlockCoachFlags.coachId, coachId),
          eq(programBlockCoachFlags.kind, "cancelled"),
        ),
      ),
    // W3-handoff: other active coaches, for the "gave it to another coach"
    // picker. Excludes self + soft-deleted; admins (role != coach) are not
    // hand-off targets.
    db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(
        and(
          eq(users.role, "coach"),
          isNull(users.deletedAt),
          ne(users.id, coachId),
        ),
      )
      .orderBy(asc(users.name)),
  ]);

  const cancelledBlockIds = new Set(cancelledFlags.map((f) => f.blockId));

  const loggedMatchers = recentLogs.map((l) => ({
    programId: l.programId,
    startMs: l.startAt.getTime(),
    endMs: l.endAt.getTime(),
  }));

  const confirmableBlocks: ConfirmableBlock[] = candidateBlocks
    .filter((b) => isBlockConfirmable(b.startAt.getTime(), nowMs))
    // Drop blocks the coach already logged a matching hour for: reuse the
    // same overlap+program predicate by treating the BLOCK as the "log"
    // and the coach's logs as the "blocks".
    .filter(
      (b) =>
        !isLogScheduled(
          {
            programId: b.programId,
            startMs: b.startAt.getTime(),
            endMs: b.endAt.getTime(),
          },
          loggedMatchers,
        ),
    )
    // Drop blocks this coach has explicitly cancelled.
    .filter((b) => !cancelledBlockIds.has(b.id))
    .map((b) => ({
      id: b.id,
      programId: b.programId,
      programName: b.programName,
      startIso: b.startAt.toISOString(),
      endIso: b.endAt.toISOString(),
      whenLabel: buildWhenLabel(b.startAt, b.endAt, now),
      overdue: isBlockOverdue(b.endAt.getTime(), nowMs),
    }));

  const displayName = user.name ?? user.email;

  // Roster for the hand-off picker: a stable display name per coach.
  const coachOptions = coachRoster.map((c) => ({
    id: c.id,
    name: c.name ?? c.email,
  }));

  return (
    <div className="space-y-6 max-w-md mx-auto">
      {confirmableBlocks.length > 0 ? (
        <ScheduleConfirmList
          blocks={confirmableBlocks}
          coaches={coachOptions}
        />
      ) : null}

      {programOptions.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)] py-16 text-center">
          <Clock className="h-8 w-8 text-gold" aria-hidden="true" />
          <p className="text-fg-muted">
            No active work yet — ask an admin to add some.
          </p>
        </div>
      ) : (
        <div>
          <div className="space-y-1.5 mb-7">
            <p className="text-[11.5px] font-semibold uppercase tracking-[0.14em] text-fg-muted">
              Log your hours
            </p>
            <p className="text-sm text-fg-muted">
              Logged for{" "}
              <span className="text-fg font-medium">{displayName}</span>.
            </p>
            <p className="text-xs text-fg-subtle">
              Logging hours that aren&rsquo;t on your schedule is allowed —
              they&rsquo;ll be flagged for review.
            </p>
          </div>

          <HourLogForm programs={programOptions} />
        </div>
      )}
    </div>
  );
}

// "Today, 4:00 – 5:00 PM" / "May 24, 2026, 4:00 – 5:00 PM" — the block's
// PFA calendar day (relative when it's today) plus its start–end range.
function buildWhenLabel(start: Date, end: Date, now: Date): string {
  const dayLabel =
    formatPfaDate(start) === formatPfaDate(now)
      ? "Today"
      : formatPfaDateMedium(start);
  return `${dayLabel}, ${formatPfaTime12h(start)} – ${formatPfaTime12h(end)}`;
}
