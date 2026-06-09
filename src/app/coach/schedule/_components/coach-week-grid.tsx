// Read-only, presentational WEEK time-grid for the coach Schedule page
// (SCR-2, QA10 W3.4). Days run across the top as columns (Mon–Sun); time of
// day runs down the rows (8 AM–10 PM, 30-min slots) — the TRANSPOSE of the
// admin Home master-schedule grid. The whole week is visible at once.
//
// ZERO interactivity by design: no hooks, no @dnd-kit, no dialogs, no
// onClick. Every bar is a plain <div> with a `title` tooltip. This component
// never imports from the interactive grids; the tiny style helpers are
// duplicated locally (same convention as master-schedule-grid.tsx) so a bug
// here can never touch the live editable grids. The time-axis math is the
// shared, unit-tested src/lib/schedule-grid-utils (placeVerticalOnGrid).
//
// Coaches never see reconciliation status, so program blocks render in a
// single neutral gold treatment — no green/red.

import {
  SCHEDULE_GRID_FIRST_HOUR,
  SCHEDULE_GRID_SLOTS,
  formatGridHour,
  placeVerticalOnGrid,
} from "@/lib/schedule-grid-utils";
import { formatPfaTime12h } from "@/lib/timezone";

type ResourceType = "cage" | "bullpen" | "weight_room";

export type CoachGridDay = {
  date: Date;
  weekdayLabel: string;
  dayLabel: string;
  isToday: boolean;
};

export type CoachGridProgramBlock = {
  id: string;
  dayIndex: number;
  programName: string;
  startAt: Date;
  endAt: Date;
  note: string | null;
};

export type CoachGridSession = {
  id: string;
  dayIndex: number;
  resourceName: string;
  resourceType: ResourceType;
  useType: "hitting" | "pitching" | null;
  isTeamRental: boolean;
  isOnline: boolean;
  startAt: Date;
  endAt: Date;
};

// Local copy of the interactive grids' tiny style helper. Duplicated on
// purpose (see file header) — do NOT import this from the live grids.
// Left-accent border for a session bar by resource type. Mirrors
// schedule-grid.tsx / master-schedule-grid.tsx typeBorder.
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

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Columns: 64px sticky time-label column + 7 equal day columns.
const gridTemplateColumns = "64px repeat(7, minmax(120px, 1fr))";
// Rows: 44px header row + SCHEDULE_GRID_SLOTS slot rows of 30px each.
const gridTemplateRows = `44px repeat(${SCHEDULE_GRID_SLOTS}, 30px)`;

export function CoachWeekGrid({
  days,
  programBlocks,
  sessions,
}: {
  days: CoachGridDay[];
  programBlocks: CoachGridProgramBlock[];
  sessions: CoachGridSession[];
}): React.JSX.Element {
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)]">
      <div className="min-w-fit">
        <div
          className="grid bg-surface"
          style={{ gridTemplateColumns, gridTemplateRows }}
        >
          {/* Header corner cell. */}
          <div
            className="sticky left-0 z-30 border-b border-r border-line bg-surface"
            style={{ gridRow: 1, gridColumn: 1 }}
          />

          {/* Day header cells. */}
          {days.map((d, dayIdx) => (
            <div
              key={`dayhead-${dayIdx}`}
              className={[
                "flex flex-col items-center justify-center gap-0.5 border-b border-l border-line bg-surface px-1",
                d.isToday ? "text-gold-strong" : "text-fg",
              ].join(" ")}
              style={{ gridRow: 1, gridColumn: dayIdx + 2 }}
            >
              <span className="text-[10px] uppercase tracking-wider text-fg-muted">
                {d.weekdayLabel}
              </span>
              <span
                className={[
                  "text-sm font-semibold tabular-nums",
                  d.isToday ? "underline decoration-gold underline-offset-2" : "",
                ].join(" ")}
              >
                {d.dayLabel}
              </span>
            </div>
          ))}

          {/* Time-label column (sticky left). One cell per slot row; hour
              boundaries are labeled, half-hour rows blank. */}
          {Array.from({ length: SCHEDULE_GRID_SLOTS }).map((_, slotIdx) => {
            const isHour = slotIdx % 2 === 0;
            const hour24 = SCHEDULE_GRID_FIRST_HOUR + Math.floor(slotIdx / 2);
            return (
              <div
                key={`time-${slotIdx}`}
                className={[
                  "sticky left-0 z-20 flex items-start justify-end pr-1.5 pt-0.5 bg-surface border-r border-line text-[10px] uppercase tracking-wider text-fg-muted",
                  isHour ? "border-t border-line-strong" : "border-t border-line/40",
                ].join(" ")}
                style={{ gridRow: slotIdx + 2, gridColumn: 1 }}
              >
                {isHour ? formatGridHour(hour24) : ""}
              </div>
            );
          })}

          {/* Empty cell backdrop (visual grid lines). */}
          {days.map((_, dayIdx) =>
            Array.from({ length: SCHEDULE_GRID_SLOTS }).map((__, slotIdx) => (
              <div
                key={`cell-${dayIdx}-${slotIdx}`}
                aria-hidden
                className={[
                  "border-l border-line bg-surface-2/40",
                  slotIdx % 2 === 0
                    ? "border-t border-line-strong"
                    : "border-t border-line/40",
                ].join(" ")}
                style={{ gridRow: slotIdx + 2, gridColumn: dayIdx + 2 }}
              />
            )),
          )}

          {/* Program block bars (neutral gold — NO recon colors). */}
          {programBlocks.map((b) => {
            const placement = placeVerticalOnGrid(b.startAt, b.endAt);
            if (!placement) return null;
            if (b.dayIndex < 0 || b.dayIndex > 6) return null;
            const timeLabel = `${formatPfaTime12h(b.startAt)}–${formatPfaTime12h(
              b.endAt,
            )}`;
            const tooltip = [
              b.programName,
              timeLabel,
              b.note ? `Note: ${b.note}` : null,
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <div
                key={`pb-${b.id}`}
                className={[
                  "m-0.5 overflow-hidden rounded-md border border-line border-l-4 border-l-gold bg-surface-2 px-1.5 py-1 text-[11px] text-fg shadow-[var(--shadow-sm)]",
                  "flex flex-col justify-start min-w-0",
                ].join(" ")}
                style={{
                  gridColumn: b.dayIndex + 2,
                  gridRow: `${placement.row + 1} / span ${placement.rowSpan}`,
                  zIndex: 2,
                }}
                title={tooltip}
              >
                <span className="truncate font-medium leading-tight">
                  {b.programName}
                </span>
                <span className="truncate text-[9px] tabular-nums text-fg-subtle">
                  {timeLabel}
                </span>
                <span className="text-[8px] uppercase tracking-wider text-gold-strong">
                  Work
                </span>
              </div>
            );
          })}

          {/* Cage-rental session bars (accent by resource type). */}
          {sessions.map((s) => {
            const placement = placeVerticalOnGrid(s.startAt, s.endAt);
            if (!placement) return null;
            if (s.dayIndex < 0 || s.dayIndex > 6) return null;
            const timeLabel = `${formatPfaTime12h(s.startAt)}–${formatPfaTime12h(
              s.endAt,
            )}`;
            const tooltip = [
              s.resourceName,
              s.useType ? cap(s.useType) : null,
              timeLabel,
              s.isTeamRental ? "Team rental" : null,
              s.isOnline ? "Online" : null,
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <div
                key={`s-${s.id}`}
                className={[
                  "m-0.5 overflow-hidden rounded-md border border-line bg-surface-2 px-1.5 py-1 text-[11px] text-fg shadow-[var(--shadow-sm)]",
                  "flex flex-col justify-start min-w-0",
                  typeBorder(s.resourceType),
                ].join(" ")}
                style={{
                  gridColumn: s.dayIndex + 2,
                  gridRow: `${placement.row + 1} / span ${placement.rowSpan}`,
                  zIndex: 3,
                }}
                title={tooltip}
              >
                <span className="flex items-center gap-1 min-w-0">
                  <span className="truncate font-medium leading-tight">
                    {s.resourceName}
                  </span>
                  {s.useType ? (
                    <span className="shrink-0 text-[8px] uppercase tracking-wider text-fg-subtle">
                      {s.useType[0]}
                    </span>
                  ) : null}
                </span>
                <span className="truncate text-[9px] tabular-nums text-fg-subtle">
                  {timeLabel}
                </span>
                <span className="flex items-center gap-1">
                  {s.isTeamRental ? (
                    <span className="text-[8px] uppercase tracking-wider text-gold-strong">
                      Team
                    </span>
                  ) : null}
                  {s.isOnline ? (
                    <span className="text-[8px] uppercase tracking-wider text-fg-subtle">
                      Online
                    </span>
                  ) : null}
                </span>
              </div>
            );
          })}
        </div>

        <Legend />
      </div>
    </div>
  );
}

function Legend(): React.JSX.Element {
  return (
    <div className="space-y-2 border-t border-line px-3 py-3 text-[11px] text-fg-muted">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <LegendDot className="border-l-4 border-l-gold bg-surface-2" label="Work" />
        <LegendDot className="border-l-4 border-l-gold" label="Cage" />
        <LegendDot className="border-l-4 border-l-success" label="Bullpen" />
        <LegendDot className="border-l-4 border-l-warning" label="Weight room" />
      </div>
      <p className="text-fg-subtle">
        Read-only overview of your work blocks and rentals this week.
      </p>
    </div>
  );
}

function LegendDot({
  className,
  label,
}: {
  className: string;
  label: string;
}): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-2">
      <span className={`inline-block h-3 w-5 rounded bg-surface-2 ${className}`} />
      {label}
    </span>
  );
}
