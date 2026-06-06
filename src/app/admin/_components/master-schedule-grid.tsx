// Read-only, presentational combined day grid for the admin Home page
// (QA4-C1). Renders, in the existing cage-grid visual language, BOTH the
// cage resource rows (sessions + blocked times) and the program rows
// (program schedule blocks) on a single shared time axis.
//
// ZERO interactivity by design: no @dnd-kit, no dialogs, no onClick, no
// hooks, no window listeners. Every bar is a plain <div> with a `title`
// tooltip. This component never imports from the interactive grids; the
// tiny style helpers (typeStripe / statusAccent / etc.) are duplicated
// locally so a bug here can never touch the live editable grids. The
// time-axis math is the shared, unit-tested src/lib/schedule-grid-utils.

import {
  SCHEDULE_GRID_FIRST_HOUR,
  SCHEDULE_GRID_LAST_HOUR,
  SCHEDULE_GRID_SLOTS,
  formatGridHour,
  placeOnGrid,
} from "@/lib/schedule-grid-utils";
import { formatPfaTime12h, pfaHour } from "@/lib/timezone";

type ResourceType = "cage" | "bullpen" | "weight_room";

export type MasterResourceRow = {
  id: string;
  name: string;
  type: ResourceType;
};

export type MasterSession = {
  id: string;
  resourceId: string;
  coachName: string;
  startAt: Date;
  endAt: Date;
  useType: "hitting" | "pitching" | null;
  isTeamRental: boolean;
};

export type MasterBlockedTime = {
  id: string;
  resourceId: string;
  startAt: Date;
  endAt: Date;
  reason: string;
};

export type MasterProgramRow = {
  id: string;
  name: string;
};

export type MasterProgramBlock = {
  id: string;
  programId: string;
  coachName: string;
  startAt: Date;
  endAt: Date;
  status?: "logged" | "wrong_coach" | "wrong_time" | "no_show" | "pending";
};

// Local copies of the interactive grids' tiny style helpers. Duplicated
// on purpose (see file header) — do NOT import these from the live grids.

// Solid fill for the resource-row label stripe — cage gold, bullpen
// green, weight room amber. Mirrors schedule-grid.tsx typeStripe.
function typeStripe(type: ResourceType): string {
  switch (type) {
    case "cage":
      return "bg-gold";
    case "bullpen":
      return "bg-success";
    case "weight_room":
      return "bg-warning";
  }
}

// Left-accent border for a session bar by resource type. Mirrors
// schedule-grid.tsx typeBorder.
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

// Program block accent + tint by reconciliation status. Mirrors
// program-schedule-grid.tsx statusAccent.
function statusAccent(status: MasterProgramBlock["status"]): string {
  switch (status) {
    case "logged":
      return "border-l-success bg-success/10";
    case "wrong_coach":
    case "wrong_time":
    case "no_show":
      return "border-l-danger bg-danger/10";
    default:
      return "border-l-gold bg-surface-2";
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function inRange(when: Date): boolean {
  // Mirrors the interactive grids' visibility filter: only render bars
  // whose start is inside the 8 AM–10 PM window. placeOnGrid still clips
  // the span for anything straddling an edge.
  return (
    pfaHour(when) >= SCHEDULE_GRID_FIRST_HOUR &&
    pfaHour(when) < SCHEDULE_GRID_LAST_HOUR
  );
}

// Optional click-to-add hook. When provided (by the editable Home wrapper),
// empty grid cells become buttons that report which section + row + slot was
// clicked. When ABSENT the grid stays exactly read-only (aria-hidden divs),
// so other read-only / print usages are unaffected. This file imports no
// dialogs — the handler is owned by the parent.
export type EmptyCellClick = (args: {
  section: "resource" | "program";
  rowId: string;
  slotIndex: number;
}) => void;

export function MasterScheduleGrid({
  resources,
  sessions,
  blockedTimes,
  programs,
  programBlocks,
  onEmptyCellClick,
}: {
  resources: MasterResourceRow[];
  sessions: MasterSession[];
  blockedTimes: MasterBlockedTime[];
  programs: MasterProgramRow[];
  programBlocks: MasterProgramBlock[];
  onEmptyCellClick?: EmptyCellClick;
}): React.JSX.Element {
  // Row index per resource / program. Row 1 is the time header; section
  // label rows are inserted between, so we lay each section out in its
  // own grid to keep the row math simple and identical to the live grids
  // (label row + 56px rows).
  const visibleSessions = sessions.filter((s) => inRange(s.startAt));
  const visibleBlocks = blockedTimes.filter((b) => inRange(b.startAt));
  const visibleProgramBlocks = programBlocks.filter((b) => inRange(b.startAt));

  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)]">
      <div className="min-w-fit">
        {/* Shared time header row. */}
        <TimeHeader />

        {/* Cage rentals section. */}
        <SectionLabel>Cage rentals</SectionLabel>
        {resources.length === 0 ? (
          <EmptyRow>No cage resources</EmptyRow>
        ) : (
          <ResourceGrid
            resources={resources}
            sessions={visibleSessions}
            blocks={visibleBlocks}
            onEmptyCellClick={onEmptyCellClick}
          />
        )}

        {/* Programs section. */}
        <SectionLabel>Programs</SectionLabel>
        {programs.length === 0 ? (
          <EmptyRow>No programs scheduled</EmptyRow>
        ) : (
          <ProgramGrid
            programs={programs}
            blocks={visibleProgramBlocks}
            onEmptyCellClick={onEmptyCellClick}
          />
        )}

        {/* Legend. */}
        <Legend />
      </div>
    </div>
  );
}

const gridTemplateColumns = `120px repeat(${SCHEDULE_GRID_SLOTS}, minmax(36px, 1fr))`;

function TimeHeader(): React.JSX.Element {
  return (
    <div
      className="grid"
      style={{
        gridTemplateColumns,
        gridTemplateRows: "40px",
      }}
    >
      {/* Header corner cell. */}
      <div
        className="sticky left-0 z-20 border-b border-r border-line bg-surface"
        style={{ gridRow: 1, gridColumn: 1 }}
      />
      {Array.from({ length: SCHEDULE_GRID_SLOTS }).map((_, slotIdx) => {
        const col = slotIdx + 2;
        const isHour = slotIdx % 2 === 0;
        const hour24 = SCHEDULE_GRID_FIRST_HOUR + Math.floor(slotIdx / 2);
        return (
          <div
            key={`h-${slotIdx}`}
            className={[
              "border-b border-line text-[10px] uppercase tracking-wider text-fg-muted",
              "flex items-end pb-1.5 pl-1",
              slotIdx % 2 === 0
                ? "border-l border-line-strong"
                : "border-l border-line/40",
            ].join(" ")}
            style={{ gridRow: 1, gridColumn: col }}
          >
            {isHour ? formatGridHour(hour24) : ""}
          </div>
        );
      })}
    </div>
  );
}

function ResourceGrid({
  resources,
  sessions,
  blocks,
  onEmptyCellClick,
}: {
  resources: MasterResourceRow[];
  sessions: MasterSession[];
  blocks: MasterBlockedTime[];
  onEmptyCellClick?: EmptyCellClick;
}): React.JSX.Element {
  const rowOf = new Map<string, number>();
  resources.forEach((r, i) => rowOf.set(r.id, i + 1));

  return (
    <div
      className="grid bg-surface"
      style={{
        gridTemplateColumns,
        gridTemplateRows: `repeat(${resources.length}, 56px)`,
      }}
    >
      {/* Resource label cells + empty cell backdrop. */}
      {resources.map((r, i) => (
        <div
          key={`label-${r.id}`}
          className="sticky left-0 z-10 border-b border-r border-line bg-surface flex items-center gap-2.5 pl-2 pr-3 py-2 text-sm font-medium text-fg"
          style={{ gridRow: i + 1, gridColumn: 1 }}
        >
          <span
            aria-hidden
            className={`h-6 w-0.5 rounded-full ${typeStripe(r.type)}`}
          />
          <span className="truncate">{r.name}</span>
        </div>
      ))}

      {/* Empty cell grid. Read-only `aria-hidden` divs by default; when an
          onEmptyCellClick handler is passed they become click-to-add buttons
          (Home's editable surface). */}
      {resources.map((r, i) =>
        Array.from({ length: SCHEDULE_GRID_SLOTS }).map((_, slotIdx) => {
          const cellClass = [
            "border-b border-line bg-surface-2/40",
            slotIdx % 2 === 0
              ? "border-l border-line-strong"
              : "border-l border-line/40",
          ].join(" ");
          const cellStyle = { gridRow: i + 1, gridColumn: slotIdx + 2 };
          if (!onEmptyCellClick) {
            return (
              <div
                key={`cell-${r.id}-${slotIdx}`}
                aria-hidden
                className={cellClass}
                style={cellStyle}
              />
            );
          }
          return (
            <button
              key={`cell-${r.id}-${slotIdx}`}
              type="button"
              onClick={() =>
                onEmptyCellClick({
                  section: "resource",
                  rowId: r.id,
                  slotIndex: slotIdx,
                })
              }
              aria-label={`Add cage rental for ${r.name}`}
              className={`${cellClass} cursor-pointer transition-colors hover:bg-gold/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold/40`}
              style={cellStyle}
            />
          );
        }),
      )}

      {/* Blocked-time bars (read-only, dashed red). */}
      {blocks.map((b) => {
        const row = rowOf.get(b.resourceId);
        if (!row) return null;
        const placement = placeOnGrid(b.startAt, b.endAt);
        if (!placement) return null;
        const timeLabel = `${formatPfaTime12h(b.startAt)}–${formatPfaTime12h(
          b.endAt,
        )}`;
        return (
          <div
            key={`block-${b.id}`}
            className={[
              "m-0.5 rounded-md border border-dashed border-danger/60 bg-danger/10 px-2 py-1 text-[11px] text-danger shadow-[var(--shadow-sm)]",
              "flex items-center min-w-0",
            ].join(" ")}
            style={{
              gridRow: row,
              gridColumn: `${placement.col} / span ${placement.span}`,
              zIndex: 1,
            }}
            title={`Blocked: ${b.reason} · ${timeLabel}`}
          >
            <span className="truncate font-medium">{b.reason}</span>
          </div>
        );
      })}

      {/* Session bars (read-only). */}
      {sessions.map((s) => {
        const row = rowOf.get(s.resourceId);
        if (!row) return null;
        const placement = placeOnGrid(s.startAt, s.endAt);
        if (!placement) return null;
        const resource = resources.find((r) => r.id === s.resourceId);
        const accent = resource ? typeBorder(resource.type) : "";
        const timeLabel = `${formatPfaTime12h(s.startAt)}–${formatPfaTime12h(
          s.endAt,
        )}`;
        const tooltip = [
          s.coachName,
          timeLabel,
          s.isTeamRental ? "Team rental" : null,
          s.useType ? cap(s.useType) : null,
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <div
            key={`s-${s.id}`}
            className={[
              "m-0.5 rounded-md border border-line bg-surface-2 px-2 py-1 text-[11px] text-fg shadow-[var(--shadow-sm)]",
              "flex items-center gap-1.5 min-w-0",
              accent,
            ].join(" ")}
            style={{
              gridRow: row,
              gridColumn: `${placement.col} / span ${placement.span}`,
              zIndex: 2,
            }}
            title={tooltip}
          >
            <span className="truncate font-medium">{s.coachName}</span>
            {s.isTeamRental ? (
              <span className="text-[9px] uppercase tracking-wider text-gold-strong shrink-0">
                Team
              </span>
            ) : null}
            {s.useType ? (
              <span className="text-[9px] uppercase tracking-wider text-fg-subtle shrink-0">
                {s.useType[0]}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function ProgramGrid({
  programs,
  blocks,
  onEmptyCellClick,
}: {
  programs: MasterProgramRow[];
  blocks: MasterProgramBlock[];
  onEmptyCellClick?: EmptyCellClick;
}): React.JSX.Element {
  const rowOf = new Map<string, number>();
  programs.forEach((p, i) => rowOf.set(p.id, i + 1));

  return (
    <div
      className="grid bg-surface"
      style={{
        gridTemplateColumns,
        gridTemplateRows: `repeat(${programs.length}, 56px)`,
      }}
    >
      {/* Program label cells. */}
      {programs.map((p, i) => (
        <div
          key={`label-${p.id}`}
          className="sticky left-0 z-10 border-b border-r border-line bg-surface flex items-center gap-2.5 pl-2 pr-3 py-2 text-sm font-medium text-fg"
          style={{ gridRow: i + 1, gridColumn: 1 }}
        >
          <span aria-hidden className="h-6 w-0.5 rounded-full bg-gold" />
          <span className="truncate">{p.name}</span>
        </div>
      ))}

      {/* Empty cell grid. Read-only `aria-hidden` divs by default; with an
          onEmptyCellClick handler they become click-to-add program buttons. */}
      {programs.map((p, i) =>
        Array.from({ length: SCHEDULE_GRID_SLOTS }).map((_, slotIdx) => {
          const cellClass = [
            "border-b border-line bg-surface-2/40",
            slotIdx % 2 === 0
              ? "border-l border-line-strong"
              : "border-l border-line/40",
          ].join(" ");
          const cellStyle = { gridRow: i + 1, gridColumn: slotIdx + 2 };
          if (!onEmptyCellClick) {
            return (
              <div
                key={`cell-${p.id}-${slotIdx}`}
                aria-hidden
                className={cellClass}
                style={cellStyle}
              />
            );
          }
          return (
            <button
              key={`cell-${p.id}-${slotIdx}`}
              type="button"
              onClick={() =>
                onEmptyCellClick({
                  section: "program",
                  rowId: p.id,
                  slotIndex: slotIdx,
                })
              }
              aria-label={`Add program block for ${p.name}`}
              className={`${cellClass} cursor-pointer transition-colors hover:bg-gold/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold/40`}
              style={cellStyle}
            />
          );
        }),
      )}

      {/* Program block bars (read-only, colored by status). */}
      {blocks.map((b) => {
        const row = rowOf.get(b.programId);
        if (!row) return null;
        const placement = placeOnGrid(b.startAt, b.endAt);
        if (!placement) return null;
        const timeLabel = `${formatPfaTime12h(b.startAt)}–${formatPfaTime12h(
          b.endAt,
        )}`;
        const tooltip = [b.coachName, timeLabel].filter(Boolean).join(" · ");
        return (
          <div
            key={`pb-${b.id}`}
            className={[
              "m-0.5 rounded-md border border-line px-2 py-1 text-[11px] text-fg shadow-[var(--shadow-sm)]",
              "flex flex-col justify-center min-w-0 border-l-4",
              statusAccent(b.status),
            ].join(" ")}
            style={{
              gridRow: row,
              gridColumn: `${placement.col} / span ${placement.span}`,
              zIndex: 2,
            }}
            title={tooltip}
          >
            <span className="truncate font-medium">{b.coachName}</span>
            <span className="truncate text-[9px] uppercase tracking-wider text-fg-subtle">
              {timeLabel}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="sticky left-0 border-b border-line bg-surface px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
      {children}
    </div>
  );
}

function EmptyRow({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="border-b border-line bg-surface-2/40 px-3 py-6 text-center text-sm text-fg-muted">
      {children}
    </div>
  );
}

function Legend(): React.JSX.Element {
  return (
    <div className="space-y-2 px-3 py-3 text-[11px] text-fg-muted">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <LegendDot className="border-l-4 border-l-gold" label="Cage" />
        <LegendDot className="border-l-4 border-l-success" label="Bullpen" />
        <LegendDot className="border-l-4 border-l-warning" label="Weight Room" />
        <LegendDot
          className="border border-dashed border-danger/60 bg-danger/10"
          label="Blocked"
        />
        <LegendDot
          className="border-l-4 border-l-success bg-success/10"
          label="On schedule"
        />
        <LegendDot
          className="border-l-4 border-l-danger bg-danger/10"
          label="Off schedule"
        />
        <LegendDot
          className="border-l-4 border-l-gold"
          label="Pending"
        />
      </div>
      <p className="text-fg-subtle">
        Read-only overview of today&apos;s cage rentals and program blocks.
        Manage them from the Schedule and Hour Log pages.
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
      <span
        className={`inline-block h-3 w-5 rounded bg-surface-2 ${className}`}
      />
      {label}
    </span>
  );
}
