import { Clock } from "lucide-react";
import { and, desc, eq, gte, lt } from "drizzle-orm";
import { db } from "@/db";
import {
  hourLogs,
  programs,
  programScheduleBlockCoaches,
  programScheduleBlocks,
} from "@/db/schema";
import { requireSession } from "@/lib/authz";
import { isLogScheduled } from "@/lib/coach-hour-log";
import { formatPfaDateMedium, formatPfaTime12h } from "@/lib/timezone";

// Coach Hour Log "History" tab (QA10 W3.7). Lists the coach's own logged
// hours, newest first (capped at 100 — no pagination for v1). Each log is
// flagged "Unscheduled" (small red badge) when it does NOT overlap any of
// the coach's scheduled program blocks for the same program — a soft
// review signal, never a block (Jacob's decision: log first, flag, no
// approval). The <h1> + sub-nav live in layout.tsx.

const HISTORY_LIMIT = 100;

export default async function CoachHourLogHistoryPage() {
  const session = await requireSession();
  const coachId = session.user.id;

  const logs = await db
    .select({
      id: hourLogs.id,
      programId: hourLogs.programId,
      programName: programs.name,
      startAt: hourLogs.startAt,
      endAt: hourLogs.endAt,
      note: hourLogs.note,
    })
    .from(hourLogs)
    .innerJoin(programs, eq(hourLogs.programId, programs.id))
    .where(eq(hourLogs.coachId, coachId))
    .orderBy(desc(hourLogs.startAt))
    .limit(HISTORY_LIMIT);

  // Fetch the coach's scheduled blocks overlapping the time span the logs
  // cover, so we can flag each log. The span is [earliest log start,
  // latest log end); when there are no logs we skip the query entirely.
  let blocks: { programId: string; startMs: number; endMs: number }[] = [];
  if (logs.length > 0) {
    let minStart = logs[0].startAt;
    let maxEnd = logs[0].endAt;
    for (const l of logs) {
      if (l.startAt < minStart) minStart = l.startAt;
      if (l.endAt > maxEnd) maxEnd = l.endAt;
    }
    const blockRows = await db
      .select({
        programId: programScheduleBlocks.programId,
        startAt: programScheduleBlocks.startAt,
        endAt: programScheduleBlocks.endAt,
      })
      .from(programScheduleBlocks)
      .innerJoin(
        programScheduleBlockCoaches,
        eq(programScheduleBlockCoaches.blockId, programScheduleBlocks.id),
      )
      .where(
        and(
          eq(programScheduleBlockCoaches.coachId, coachId),
          // A block can only overlap a log in the span if it starts before
          // the span ends and ends after the span starts (half-open).
          lt(programScheduleBlocks.startAt, maxEnd),
          gte(programScheduleBlocks.endAt, minStart),
        ),
      );
    blocks = blockRows.map((b) => ({
      programId: b.programId,
      startMs: b.startAt.getTime(),
      endMs: b.endAt.getTime(),
    }));
  }

  const rows = logs.map((log) => ({
    ...log,
    scheduled: isLogScheduled(
      {
        programId: log.programId,
        startMs: log.startAt.getTime(),
        endMs: log.endAt.getTime(),
      },
      blocks,
    ),
  }));

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)] py-16 text-center">
        <Clock className="h-8 w-8 text-gold" aria-hidden="true" />
        <p className="text-fg-muted">
          No hours logged yet — log your first from the Log hours tab.
        </p>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-line rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)] overflow-hidden">
      {rows.map((row) => (
        <li
          key={row.id}
          className="flex items-center gap-3 px-3.5 py-2.5 transition hover:bg-surface-2"
        >
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="text-xs font-medium uppercase tracking-wider text-fg-muted whitespace-nowrap">
                {formatPfaDateMedium(row.startAt)}
              </span>
              <span className="text-sm font-medium tabular-nums text-fg whitespace-nowrap">
                {formatPfaTime12h(row.startAt)} – {formatPfaTime12h(row.endAt)}
              </span>
              <span className="text-sm text-fg-muted truncate">
                {row.programName}
              </span>
              {!row.scheduled ? <UnscheduledBadge /> : null}
            </div>
            {row.note ? (
              <p
                className="mt-0.5 text-xs text-fg-subtle leading-snug truncate"
                title={row.note}
              >
                {row.note}
              </p>
            ) : null}
          </div>

          <span className="text-xs font-mono tabular-nums text-fg-muted whitespace-nowrap">
            {formatDuration(row.startAt, row.endAt)}
          </span>
        </li>
      ))}
    </ul>
  );
}

// Small red pill flagging a log that doesn't match any scheduled block.
function UnscheduledBadge() {
  return (
    <span className="inline-flex items-center rounded-full border border-danger/30 bg-danger/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-danger whitespace-nowrap">
      Unscheduled
    </span>
  );
}

function formatDuration(start: Date, end: Date): string {
  const minutes = Math.round((end.getTime() - start.getTime()) / 60_000);
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return `${mins} min`;
  if (mins === 0) return `${hours} hr`;
  return `${hours} hr ${mins} min`;
}
