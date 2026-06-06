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
import { assignLanes } from "@/lib/schedule-lanes";
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

// QA10 W3.9: optional click-to-VIEW/EDIT hook for the existing bars. When
// provided (by the editable Home wrapper) each session / blocked-time /
// program-block bar becomes a <button> that reports which kind + id was
// clicked, so the parent can open the matching edit dialog. When ABSENT the
// bars stay exactly the read-only <div>s they are today (other read-only /
// print usages, + the existing tests, are unaffected). Mirrors the
// onEmptyCellClick pattern: this file imports no dialogs — the handler is
// owned by the parent.
export type BlockClick = (b: {
  kind: "session" | "block" | "program";
  id: string;
}) => void;

export function MasterScheduleGrid({
  resources,
  sessions,
  blockedTimes,
  programs,
  programBlocks,
  onEmptyCellClick,
  onBlockClick,
}: {
  resources: MasterResourceRow[];
  sessions: MasterSession[];
  blockedTimes: MasterBlockedTime[];
  programs: MasterProgramRow[];
  programBlocks: MasterProgramBlock[];
  onEmptyCellClick?: EmptyCellClick;
  onBlockClick?: BlockClick;
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
            onBlockClick={onBlockClick}
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
            onBlockClick={onBlockClick}
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
  onBlockClick,
}: {
  resources: MasterResourceRow[];
  sessions: MasterSession[];
  blocks: MasterBlockedTime[];
  onEmptyCellClick?: EmptyCellClick;
  onBlockClick?: BlockClick;
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
        const barClass = [
          "m-0.5 rounded-md border border-dashed border-danger/60 bg-danger/10 px-2 py-1 text-[11px] text-danger shadow-[var(--shadow-sm)]",
          "flex items-center min-w-0",
        ].join(" ");
        const barStyle = {
          gridRow: row,
          gridColumn: `${placement.col} / span ${placement.span}`,
          zIndex: 1,
        };
        if (onBlockClick) {
          return (
            <button
              key={`block-${b.id}`}
              type="button"
              onClick={() => onBlockClick({ kind: "block", id: b.id })}
              className={`${barClass} text-left cursor-pointer transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/50`}
              style={barStyle}
              title={`Blocked: ${b.reason} · ${timeLabel} (click for details)`}
            >
              <span className="truncate font-medium">{b.reason}</span>
            </button>
          );
        }
        return (
          <div
            key={`block-${b.id}`}
            className={barClass}
            style={barStyle}
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
        const barClass = [
          "m-0.5 rounded-md border border-line bg-surface-2 px-2 py-1 text-[11px] text-fg shadow-[var(--shadow-sm)]",
          "flex items-center gap-1.5 min-w-0",
          accent,
        ].join(" ");
        const barStyle = {
          gridRow: row,
          gridColumn: `${placement.col} / span ${placement.span}`,
          zIndex: 2,
        };
        const inner = (
          <>
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
          </>
        );
        if (onBlockClick) {
          return (
            <button
              key={`s-${s.id}`}
              type="button"
              onClick={() => onBlockClick({ kind: "session", id: s.id })}
              className={`${barClass} text-left cursor-pointer transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/50`}
              style={barStyle}
              title={`${tooltip} (click for details)`}
            >
              {inner}
            </button>
          );
        }
        return (
          <div
            key={`s-${s.id}`}
            className={barClass}
            style={barStyle}
            title={tooltip}
          >
            {inner}
          </div>
        );
      })}
    </div>
  );
}

// QA10 W3.8b: the Programs section is now a SINGLE combined timeline
// (mirroring the standalone Program Schedule grid, W3.8a) instead of one row
// per program. Non-overlapping program blocks share a compact lane row;
// overlapping blocks stack into as many lanes as the concurrency needs (pure
// `assignLanes`). Each bar's primary label is the PROGRAM name (the coach
// moves to the tooltip). The leading 120px column stays empty so the time
// columns line up exactly with the cage section + the shared time header.
function ProgramGrid({
  programs,
  blocks,
  onEmptyCellClick,
  onBlockClick,
}: {
  programs: MasterProgramRow[];
  blocks: MasterProgramBlock[];
  onEmptyCellClick?: EmptyCellClick;
  onBlockClick?: BlockClick;
}): React.JSX.Element {
  const programNameById = new Map(programs.map((p) => [p.id, p.name]));

  // Dynamic lane-stacking across ALL visible program blocks. Lane index →
  // grid row (lane + 1; this section's grid has no header row of its own).
  // Always render at least one lane row so the empty cells still show + stay
  // clickable.
  const { laneByBlockId, laneCount } = assignLanes(
    blocks.map((b) => ({ id: b.id, startAt: b.startAt, endAt: b.endAt })),
  );
  const laneRows = Math.max(laneCount, 1);

  // A slot column is "occupied" if ANY visible block covers it, so empty-cell
  // clicks only land on free time. Keyed by 0-based slot index.
  const occupiedSlots = new Set<number>();
  for (const b of blocks) {
    const placement = placeOnGrid(b.startAt, b.endAt);
    if (!placement) continue;
    // placement.col is 1-based and includes the leading label column
    // (slot 0 → col 2). Recover the 0-based slot index.
    const startSlot = placement.col - 2;
    for (let i = 0; i < placement.span; i++) {
      occupiedSlots.add(startSlot + i);
    }
  }

  return (
    <div
      className="grid bg-surface"
      style={{
        gridTemplateColumns,
        gridTemplateRows: `repeat(${laneRows}, 56px)`,
      }}
    >
      {/* Empty leading label column — kept blank (no per-program label) so the
          time columns align with the cage section + the shared header. */}
      {Array.from({ length: laneRows }).map((_, laneIdx) => (
        <div
          key={`label-${laneIdx}`}
          aria-hidden
          className="sticky left-0 z-10 border-b border-r border-line bg-surface"
          style={{ gridRow: laneIdx + 1, gridColumn: 1 }}
        />
      ))}

      {/* Empty cell grid — one per (lane row × slot). Read-only `aria-hidden`
          divs by default; with an onEmptyCellClick handler the FREE cells
          become click-to-add program buttons. There are no per-program rows
          now, so the click carries rowId "" — the admin picks the program in
          the create dialog. Occupied cells skip the click so the bar wins. */}
      {Array.from({ length: laneRows }).map((_, laneIdx) =>
        Array.from({ length: SCHEDULE_GRID_SLOTS }).map((_, slotIdx) => {
          const isOccupied = occupiedSlots.has(slotIdx);
          const cellClass = [
            "border-b border-line bg-surface-2/40",
            slotIdx % 2 === 0
              ? "border-l border-line-strong"
              : "border-l border-line/40",
          ].join(" ");
          const cellStyle = { gridRow: laneIdx + 1, gridColumn: slotIdx + 2 };
          if (!onEmptyCellClick || isOccupied) {
            return (
              <div
                key={`cell-${laneIdx}-${slotIdx}`}
                aria-hidden
                className={cellClass}
                style={cellStyle}
              />
            );
          }
          return (
            <button
              key={`cell-${laneIdx}-${slotIdx}`}
              type="button"
              onClick={() =>
                onEmptyCellClick({
                  section: "program",
                  rowId: "",
                  slotIndex: slotIdx,
                })
              }
              aria-label={`Add program block at ${formatGridHour(
                SCHEDULE_GRID_FIRST_HOUR + Math.floor(slotIdx / 2),
              )}${slotIdx % 2 === 1 ? ":30" : ""}`}
              className={`${cellClass} cursor-pointer transition-colors hover:bg-gold/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold/40`}
              style={cellStyle}
            />
          );
        }),
      )}

      {/* Program block bars (read-only, colored by status). Row = the block's
          assigned lane + 1; primary label = the PROGRAM name. */}
      {blocks.map((b) => {
        const lane = laneByBlockId.get(b.id);
        if (lane === undefined) return null;
        const placement = placeOnGrid(b.startAt, b.endAt);
        if (!placement) return null;
        const timeLabel = `${formatPfaTime12h(b.startAt)}–${formatPfaTime12h(
          b.endAt,
        )}`;
        const programLabel = programNameById.get(b.programId) ?? b.programId;
        // Coach name moves OFF the bar into the tooltip; tooltip leads with
        // the program name.
        const tooltip = [programLabel, b.coachName, timeLabel]
          .filter(Boolean)
          .join(" · ");
        const barClass = [
          "m-0.5 rounded-md border border-line px-2 py-1 text-[11px] text-fg shadow-[var(--shadow-sm)]",
          "flex flex-col justify-center min-w-0 border-l-4",
          statusAccent(b.status),
        ].join(" ");
        const barStyle = {
          gridRow: lane + 1,
          gridColumn: `${placement.col} / span ${placement.span}`,
          zIndex: 2,
        };
        const inner = (
          <>
            <span className="truncate font-medium">{programLabel}</span>
            <span className="truncate text-[9px] uppercase tracking-wider text-fg-subtle">
              {timeLabel}
            </span>
          </>
        );
        if (onBlockClick) {
          return (
            <button
              key={`pb-${b.id}`}
              type="button"
              onClick={() => onBlockClick({ kind: "program", id: b.id })}
              className={`${barClass} text-left cursor-pointer transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/50`}
              style={barStyle}
              title={`${tooltip} (click for details)`}
            >
              {inner}
            </button>
          );
        }
        return (
          <div
            key={`pb-${b.id}`}
            className={barClass}
            style={barStyle}
            title={tooltip}
          >
            {inner}
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
