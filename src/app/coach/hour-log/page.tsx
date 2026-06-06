import { Clock } from "lucide-react";
import { and, asc, eq, gte, lt } from "drizzle-orm";
import { db } from "@/db";
import {
  hourLogs,
  programs,
  programScheduleBlockCoaches,
  programScheduleBlocks,
} from "@/db/schema";
import { requireSession } from "@/lib/authz";
import {
  CONFIRM_WINDOW_MS,
  isBlockConfirmable,
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

// Coach hour-log "Log hours" tab (QA10 W3.7). Two stacked sections:
//   1. Confirm-the-schedule — the coach's scheduled program blocks whose
//      end is within 15 min of now, each one tap away from being logged.
//   2. The manual HourLogForm (unchanged), for any hours on or off the
//      schedule. The <h1> + sub-nav live in layout.tsx.
//
// DEC-29: coaches may log against ANY active program. Public server
// action `logOwnHour` enforces coachId = self regardless of any
// client-supplied value.

// We query scheduled blocks ending in a tight window around now (one
// hour either side) — a cheap, index-friendly DB filter — then keep only
// those the 15-min `isBlockConfirmable` window admits. The query window
// is wider than the confirm window so a block ending up to an hour ago is
// still a candidate the predicate can reject precisely.
const QUERY_PAD_MS = 60 * 60 * 1000;

export default async function CoachHourLogPage() {
  const session = await requireSession();
  const { user } = session;
  const coachId = user.id;

  const now = new Date();
  const nowMs = now.getTime();
  const windowStart = new Date(nowMs - QUERY_PAD_MS - CONFIRM_WINDOW_MS);
  const windowEnd = new Date(nowMs + QUERY_PAD_MS + CONFIRM_WINDOW_MS);

  const [programOptions, candidateBlocks, recentLogs] = await Promise.all([
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
          lt(programScheduleBlocks.endAt, windowEnd),
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
          lt(hourLogs.startAt, windowEnd),
        ),
      ),
  ]);

  const loggedMatchers = recentLogs.map((l) => ({
    programId: l.programId,
    startMs: l.startAt.getTime(),
    endMs: l.endAt.getTime(),
  }));

  const confirmableBlocks: ConfirmableBlock[] = candidateBlocks
    .filter((b) => isBlockConfirmable(b.endAt.getTime(), nowMs))
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
    .map((b) => ({
      id: b.id,
      programId: b.programId,
      programName: b.programName,
      startIso: b.startAt.toISOString(),
      endIso: b.endAt.toISOString(),
      whenLabel: buildWhenLabel(b.startAt, b.endAt, now),
    }));

  const displayName = user.name ?? user.email;

  return (
    <div className="space-y-6 max-w-md mx-auto">
      {confirmableBlocks.length > 0 ? (
        <ScheduleConfirmList blocks={confirmableBlocks} />
      ) : null}

      {programOptions.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)] py-16 text-center">
          <Clock className="h-8 w-8 text-gold" aria-hidden="true" />
          <p className="text-fg-muted">
            No active programs yet — ask an admin to add one.
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
