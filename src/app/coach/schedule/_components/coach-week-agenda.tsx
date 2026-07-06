// Mobile-only vertical day-by-day agenda for the coach Schedule page
// (SCR-2, QA10 W3-polish18b). On a phone the desktop week GRID
// (coach-week-grid.tsx) is ~44px/day with clipped bar text — unreadable.
// This is a top-to-bottom list: one section per day (Mon–Sun), each day's
// program blocks + cage sessions merged and sorted by start time.
//
// ZERO interactivity by design — pure presentational render, no hooks, no
// data fetching, no server imports. Takes the SAME props as CoachWeekGrid
// (days/programBlocks/sessions) so it's previewable with mock data. The
// types come from ./coach-week-grid; the tiny typeBorder/cap helpers are
// duplicated locally (same convention as the grid).

import { formatPfaTime12h } from "@/lib/timezone";
import { GroupPill } from "@/app/_components/group-pill";
import type {
  CoachGridDay,
  CoachGridProgramBlock,
  CoachGridSession,
} from "./coach-week-grid";

type ResourceType = "cage" | "bullpen" | "weight_room";

// Local copy of the grid's tiny style helper (see file header). Left-accent
// border for a session row by resource type — mirrors coach-week-grid.tsx.
function typeBorder(type: ResourceType): string {
  switch (type) {
    case "cage":
      return "border-l-4 border-l-gold";
    case "bullpen":
      return "border-l-4 border-l-success";
    case "weight_room":
      return "border-l-4 border-l-warning";
  }
}

type AgendaItem =
  | { kind: "block"; startAt: Date; block: CoachGridProgramBlock }
  | { kind: "session"; startAt: Date; session: CoachGridSession };

export function CoachWeekAgenda({
  days,
  programBlocks,
  sessions,
}: {
  days: CoachGridDay[];
  programBlocks: CoachGridProgramBlock[];
  sessions: CoachGridSession[];
}): React.JSX.Element {
  return (
    <div className="space-y-3">
      {days.map((d, i) => {
        const items: AgendaItem[] = [
          ...programBlocks
            .filter((b) => b.dayIndex === i)
            .map<AgendaItem>((b) => ({
              kind: "block",
              startAt: b.startAt,
              block: b,
            })),
          ...sessions
            .filter((s) => s.dayIndex === i)
            .map<AgendaItem>((s) => ({
              kind: "session",
              startAt: s.startAt,
              session: s,
            })),
        ].sort((a, b) => a.startAt.getTime() - b.startAt.getTime());

        return (
          <section
            key={`agenda-day-${i}`}
            className="overflow-hidden rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)]"
          >
            <header
              className={[
                "sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-line px-3 py-2",
                d.isToday ? "bg-gold/10" : "bg-surface",
              ].join(" ")}
            >
              <span
                className={[
                  "text-sm font-semibold tabular-nums",
                  d.isToday ? "text-gold-strong" : "text-fg",
                ].join(" ")}
              >
                {d.weekdayLabel} · {d.dayLabel}
              </span>
              {d.isToday ? (
                <span className="rounded-full bg-gold/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-gold-strong">
                  Today
                </span>
              ) : null}
            </header>

            {items.length === 0 ? (
              <p className="px-3 py-3 text-xs italic text-fg-subtle">
                Nothing scheduled
              </p>
            ) : (
              <ul className="divide-y divide-line/60">
                {items.map((item) =>
                  item.kind === "block" ? (
                    <BlockRow
                      key={`pb-${item.block.id}`}
                      block={item.block}
                    />
                  ) : (
                    <SessionRow
                      key={`s-${item.session.id}`}
                      session={item.session}
                    />
                  ),
                )}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

function timeRange(startAt: Date, endAt: Date): string {
  return `${formatPfaTime12h(startAt)}–${formatPfaTime12h(endAt)}`;
}

function BlockRow({
  block,
}: {
  block: CoachGridProgramBlock;
}): React.JSX.Element {
  return (
    <li className="flex items-start gap-3 border-l-4 border-l-blue px-3 py-2.5">
      <span className="shrink-0 pt-0.5 text-[11px] tabular-nums text-fg-muted">
        {timeRange(block.startAt, block.endAt)}
      </span>
      <div className="min-w-0">
        <p className="font-medium leading-tight text-fg">
          {block.programName}
        </p>
        <p className="text-[10px] uppercase tracking-wider text-blue-strong">
          Work
        </p>
        {block.note ? (
          <p className="mt-0.5 truncate text-xs text-fg-subtle">
            {block.note}
          </p>
        ) : null}
      </div>
    </li>
  );
}

function SessionRow({
  session,
}: {
  session: CoachGridSession;
}): React.JSX.Element {
  return (
    <li
      className={[
        "flex items-start gap-3 px-3 py-2.5",
        typeBorder(session.resourceType),
      ].join(" ")}
    >
      <span className="shrink-0 pt-0.5 text-[11px] tabular-nums text-fg-muted">
        {timeRange(session.startAt, session.endAt)}
      </span>
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 font-medium leading-tight text-fg">
          <span className="truncate">{session.resourceName}</span>
          {session.isGroupSession ? <GroupPill /> : null}
        </p>
      </div>
    </li>
  );
}
