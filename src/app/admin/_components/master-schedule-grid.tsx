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

import { useDraggable, useDroppable } from "@dnd-kit/core";
import {
  PROGRAM_GRID_SLOTS,
  SCHEDULE_GRID_FIRST_HOUR,
  SCHEDULE_GRID_LAST_HOUR,
  SCHEDULE_GRID_SLOTS,
  formatGridHour,
  placeOnGrid,
  placeOnGrid15,
} from "@/lib/schedule-grid-utils";
import { assignLanes } from "@/lib/schedule-lanes";
import { formatPfaTime12h, pfaHour } from "@/lib/timezone";

// #15B drag-to-MOVE. The single DndContext lives in the editable wrapper
// (editable-master-schedule.tsx). These data shapes are what each draggable
// bar / droppable cell carries; the wrapper's handleDragEnd demultiplexes on
// `type`. @dnd-kit serializes data, so Dates are passed as ISO strings.
export type MasterSessionDragData = {
  type: "session";
  id: string;
  startAt: string;
  endAt: string;
};

export type MasterProgramBlockDragData = {
  type: "program-block";
  id: string;
  startAt: string;
  endAt: string;
};

export type MasterCellDropData =
  | { type: "cell"; section: "resource"; resourceId: string; slotIndex: number }
  | { type: "cell"; section: "program"; slotIndex: number };

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
      return "border-l-blue bg-blue/10";
  }
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
  // #15B: when true the wrapper has mounted a DndContext around this grid, so
  // session / program-block bars become @dnd-kit draggables and empty cells
  // become droppables. When false/absent the grid renders exactly as before
  // (read-only or click-only usages elsewhere are unaffected — no hook calls).
  dragEnabled = false,
  // Id of the bar currently being dragged (from the wrapper's onDragStart), so
  // its own footprint is excluded from the "occupied" set — otherwise a
  // half-slot shift in place is rejected because the source cells read as busy.
  draggingId = null,
}: {
  resources: MasterResourceRow[];
  sessions: MasterSession[];
  blockedTimes: MasterBlockedTime[];
  programs: MasterProgramRow[];
  programBlocks: MasterProgramBlock[];
  onEmptyCellClick?: EmptyCellClick;
  onBlockClick?: BlockClick;
  dragEnabled?: boolean;
  draggingId?: string | null;
}): React.JSX.Element {
  // Row index per resource / program. Row 1 is the time header; section
  // label rows are inserted between, so we lay each section out in its
  // own grid to keep the row math simple and identical to the live grids
  // (label row + 56px rows).
  const visibleSessions = sessions.filter((s) => inRange(s.startAt));
  const visibleBlocks = blockedTimes.filter((b) => inRange(b.startAt));
  const visibleProgramBlocks = programBlocks.filter((b) => inRange(b.startAt));

  return (
    <>
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
            dragEnabled={dragEnabled}
            draggingId={draggingId}
          />
        )}

        {/* Programs section. */}
        <SectionLabel>Work</SectionLabel>
        {programs.length === 0 ? (
          <EmptyRow>No work scheduled</EmptyRow>
        ) : (
          <ProgramGrid
            programs={programs}
            blocks={visibleProgramBlocks}
            onEmptyCellClick={onEmptyCellClick}
            onBlockClick={onBlockClick}
            dragEnabled={dragEnabled}
            draggingId={draggingId}
          />
        )}

        {/* Legend. */}
        <Legend />
      </div>
    </div>
    <p className="mt-2 text-[11px] text-fg-subtle md:hidden">
      Scroll the schedule sideways to see all times.
    </p>
    </>
  );
}

const gridTemplateColumns = `120px repeat(${SCHEDULE_GRID_SLOTS}, minmax(36px, 1fr))`;
// #8: the Work (program) section uses 15-min resolution → 56 equal-fraction
// time columns vs the cage section's 28. Same leading 120px label column and
// equal fractions, and 56 = 2×28, so the columns line up at identical clock
// times with the cage section + the shared 28-slot time header.
const programGridTemplateColumns = `120px repeat(${PROGRAM_GRID_SLOTS}, minmax(18px, 1fr))`;

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
  dragEnabled,
  draggingId,
}: {
  resources: MasterResourceRow[];
  sessions: MasterSession[];
  blocks: MasterBlockedTime[];
  onEmptyCellClick?: EmptyCellClick;
  onBlockClick?: BlockClick;
  dragEnabled?: boolean;
  draggingId?: string | null;
}): React.JSX.Element {
  const rowOf = new Map<string, number>();
  resources.forEach((r, i) => rowOf.set(r.id, i + 1));

  // #15B: which (resourceId, 30-min slot) cells are covered by a session or
  // block, so droppable empty cells skip them (the bar wins the drop). The
  // actively-dragged session's own footprint is excluded so a shift-in-place
  // is allowed. Blocked times always count as occupied.
  const occupiedCells = new Set<string>();
  if (dragEnabled) {
    for (const s of sessions) {
      if (s.id === draggingId) continue;
      const p = placeOnGrid(s.startAt, s.endAt);
      if (!p) continue;
      for (let i = 0; i < p.span; i++) {
        occupiedCells.add(`${s.resourceId}-${p.col - 2 + i}`);
      }
    }
    for (const b of blocks) {
      const p = placeOnGrid(b.startAt, b.endAt);
      if (!p) continue;
      for (let i = 0; i < p.span; i++) {
        occupiedCells.add(`${b.resourceId}-${p.col - 2 + i}`);
      }
    }
  }

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
          // #15B: when drag is enabled the empty cell is BOTH a click-to-add
          // button AND a droppable move target. distance:5 on the wrapper's
          // PointerSensor lets a plain click through as a click. Occupied
          // cells skip the droppable so the bar's own footprint wins.
          if (dragEnabled) {
            return (
              <ResourceDroppableCell
                key={`cell-${r.id}-${slotIdx}`}
                resourceId={r.id}
                resourceName={r.name}
                slotIdx={slotIdx}
                cellClass={cellClass}
                cellStyle={cellStyle}
                isOccupied={occupiedCells.has(`${r.id}-${slotIdx}`)}
                onCreate={() =>
                  onEmptyCellClick({
                    section: "resource",
                    rowId: r.id,
                    slotIndex: slotIdx,
                  })
                }
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
        const tooltip = [s.coachName, timeLabel]
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
          </>
        );
        // #15B: drag enabled → draggable bar that ALSO opens the edit dialog
        // on a plain click (distance:5 sensor distinguishes click vs drag).
        if (dragEnabled) {
          return (
            <DraggableSessionBar
              key={`s-${s.id}`}
              session={s}
              barClass={barClass}
              barStyle={barStyle}
              tooltip={tooltip}
              onEdit={
                onBlockClick
                  ? () => onBlockClick({ kind: "session", id: s.id })
                  : undefined
              }
            >
              {inner}
            </DraggableSessionBar>
          );
        }
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

// #15B: a cage SESSION bar that is draggable (move) and clickable (edit). The
// distance:5 PointerSensor on the wrapper's DndContext lets a short click
// reach onEdit while a >5px drag becomes a move. Mirrors the cage grid's
// DraggableSession (translate3d transform + opacity while dragging).
function DraggableSessionBar({
  session,
  barClass,
  barStyle,
  tooltip,
  onEdit,
  children,
}: {
  session: MasterSession;
  barClass: string;
  barStyle: React.CSSProperties;
  tooltip: string;
  onEdit?: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({
      id: `session-${session.id}`,
      data: {
        type: "session",
        id: session.id,
        startAt: session.startAt.toISOString(),
        endAt: session.endAt.toISOString(),
      } satisfies MasterSessionDragData,
    });

  const dragTransform = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : null;

  return (
    <button
      ref={setNodeRef}
      type="button"
      onClick={onEdit}
      {...listeners}
      {...attributes}
      className={`${barClass} text-left transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/50 ${
        isDragging ? "opacity-40 cursor-grabbing" : "cursor-grab"
      }`}
      style={{
        ...barStyle,
        zIndex: isDragging ? 30 : (barStyle.zIndex as number | undefined),
        ...dragTransform,
      }}
      title={onEdit ? `${tooltip} (click for details, drag to move)` : tooltip}
    >
      {children}
    </button>
  );
}

// #15B: a droppable empty CAGE cell. Drop data carries the 30-min slot index +
// resource so the wrapper can compute the new start time and (possibly new)
// resource row. Occupied cells set `disabled` so the bar's footprint wins.
function ResourceDroppableCell({
  resourceId,
  resourceName,
  slotIdx,
  cellClass,
  cellStyle,
  isOccupied,
  onCreate,
}: {
  resourceId: string;
  resourceName: string;
  slotIdx: number;
  cellClass: string;
  cellStyle: React.CSSProperties;
  isOccupied: boolean;
  onCreate: () => void;
}): React.JSX.Element {
  const { setNodeRef, isOver } = useDroppable({
    id: `mdrop-resource-${resourceId}-${slotIdx}`,
    data: {
      type: "cell",
      section: "resource",
      resourceId,
      slotIndex: slotIdx,
    } satisfies MasterCellDropData,
    disabled: isOccupied,
  });
  return (
    <button
      ref={setNodeRef}
      type="button"
      onClick={isOccupied ? undefined : onCreate}
      disabled={isOccupied}
      aria-label={isOccupied ? undefined : `Add cage rental for ${resourceName}`}
      className={`${cellClass} ${
        isOccupied
          ? "cursor-default"
          : `cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold/40 ${
              isOver ? "bg-gold/20" : "hover:bg-gold/10"
            }`
      }`}
      style={cellStyle}
    />
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
  dragEnabled,
  draggingId,
}: {
  programs: MasterProgramRow[];
  blocks: MasterProgramBlock[];
  onEmptyCellClick?: EmptyCellClick;
  onBlockClick?: BlockClick;
  dragEnabled?: boolean;
  draggingId?: string | null;
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
    // #15B: exclude the actively-dragged block's own slots so a shift-in-place
    // (e.g. nudging it 15 min) isn't rejected as "dropping onto itself".
    if (dragEnabled && b.id === draggingId) continue;
    const placement = placeOnGrid15(b.startAt, b.endAt);
    if (!placement) continue;
    // placeOnGrid15.col is 1-based with NO leading label column (slot 0 →
    // col 1). Recover the 0-based 15-min slot index.
    const startSlot = placement.col - 1;
    for (let i = 0; i < placement.span; i++) {
      occupiedSlots.add(startSlot + i);
    }
  }

  return (
    <div
      className="grid bg-surface"
      style={{
        gridTemplateColumns: programGridTemplateColumns,
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
        Array.from({ length: PROGRAM_GRID_SLOTS }).map((_, slotIdx) => {
          const isOccupied = occupiedSlots.has(slotIdx);
          const cellClass = [
            "border-b border-line bg-surface-2/40",
            slotIdx % 4 === 0
              ? "border-l border-line-strong"
              : "border-l border-line/40",
          ].join(" ");
          const cellStyle = { gridRow: laneIdx + 1, gridColumn: slotIdx + 2 };
          if (!onEmptyCellClick || isOccupied) {
            // #15B: even an "occupied" or read-only cell must still be a drop
            // target when dragging — a program block can move ONTO a column
            // another lane's block already covers (they just stack in lanes).
            // So when drag is enabled we render a droppable backdrop div for
            // every free cell; occupied cells (covered by a NON-dragging block)
            // stay plain so they don't intercept the drop meant for the bar.
            if (dragEnabled && !isOccupied) {
              return (
                <ProgramDroppableCell
                  key={`cell-${laneIdx}-${slotIdx}`}
                  laneIdx={laneIdx}
                  slotIdx={slotIdx}
                  cellClass={cellClass}
                  cellStyle={cellStyle}
                  onCreate={
                    onEmptyCellClick
                      ? () =>
                          onEmptyCellClick({
                            section: "program",
                            rowId: "",
                            slotIndex: slotIdx,
                          })
                      : undefined
                  }
                />
              );
            }
            return (
              <div
                key={`cell-${laneIdx}-${slotIdx}`}
                aria-hidden
                className={cellClass}
                style={cellStyle}
              />
            );
          }
          if (dragEnabled) {
            return (
              <ProgramDroppableCell
                key={`cell-${laneIdx}-${slotIdx}`}
                laneIdx={laneIdx}
                slotIdx={slotIdx}
                cellClass={cellClass}
                cellStyle={cellStyle}
                onCreate={() =>
                  onEmptyCellClick({
                    section: "program",
                    rowId: "",
                    slotIndex: slotIdx,
                  })
                }
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
              aria-label={`Add work block at ${formatGridHour(
                SCHEDULE_GRID_FIRST_HOUR + Math.floor(slotIdx / 4),
              )}${
                slotIdx % 4 !== 0
                  ? `:${String((slotIdx % 4) * 15).padStart(2, "0")}`
                  : ""
              }`}
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
        const placement = placeOnGrid15(b.startAt, b.endAt);
        if (!placement) return null;
        // placeOnGrid15.col has NO leading label column; this grid does, so
        // shift the bar one column right to clear the 120px label column.
        const gridColumn = `${placement.col + 1} / span ${placement.span}`;
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
          gridColumn,
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
        // #15B: drag enabled → draggable program-block bar that ALSO opens its
        // edit dialog on a plain click.
        if (dragEnabled) {
          return (
            <DraggableProgramBlockBar
              key={`pb-${b.id}`}
              block={b}
              barClass={barClass}
              barStyle={barStyle}
              tooltip={tooltip}
              onEdit={
                onBlockClick
                  ? () => onBlockClick({ kind: "program", id: b.id })
                  : undefined
              }
            >
              {inner}
            </DraggableProgramBlockBar>
          );
        }
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

// #15B: a droppable empty PROGRAM (15-min) cell. Drop data carries only the
// 15-min slot index (programs have no per-resource rows in this combined
// timeline — the move preserves the block's program/coach/resources). Click
// still creates when an onCreate handler is present.
function ProgramDroppableCell({
  laneIdx,
  slotIdx,
  cellClass,
  cellStyle,
  onCreate,
}: {
  laneIdx: number;
  slotIdx: number;
  cellClass: string;
  cellStyle: React.CSSProperties;
  onCreate?: () => void;
}): React.JSX.Element {
  const { setNodeRef, isOver } = useDroppable({
    id: `mdrop-program-${laneIdx}-${slotIdx}`,
    data: {
      type: "cell",
      section: "program",
      slotIndex: slotIdx,
    } satisfies MasterCellDropData,
  });
  if (!onCreate) {
    return (
      <div
        ref={setNodeRef}
        aria-hidden
        className={`${cellClass} ${isOver ? "bg-gold/20" : ""}`}
        style={cellStyle}
      />
    );
  }
  return (
    <button
      ref={setNodeRef}
      type="button"
      onClick={onCreate}
      aria-label={`Add work block at ${formatGridHour(
        SCHEDULE_GRID_FIRST_HOUR + Math.floor(slotIdx / 4),
      )}${
        slotIdx % 4 !== 0
          ? `:${String((slotIdx % 4) * 15).padStart(2, "0")}`
          : ""
      }`}
      className={`${cellClass} cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold/40 ${
        isOver ? "bg-gold/20" : "hover:bg-gold/10"
      }`}
      style={cellStyle}
    />
  );
}

// #15B: a program-block bar that is draggable (15-min move) and clickable
// (edit). Mirrors DraggableSessionBar but carries program-block drag data.
function DraggableProgramBlockBar({
  block,
  barClass,
  barStyle,
  tooltip,
  onEdit,
  children,
}: {
  block: MasterProgramBlock;
  barClass: string;
  barStyle: React.CSSProperties;
  tooltip: string;
  onEdit?: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({
      id: `program-block-${block.id}`,
      data: {
        type: "program-block",
        id: block.id,
        startAt: block.startAt.toISOString(),
        endAt: block.endAt.toISOString(),
      } satisfies MasterProgramBlockDragData,
    });

  const dragTransform = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : null;

  return (
    <button
      ref={setNodeRef}
      type="button"
      onClick={onEdit}
      {...listeners}
      {...attributes}
      className={`${barClass} text-left transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/50 ${
        isDragging ? "opacity-40 cursor-grabbing" : "cursor-grab"
      }`}
      style={{
        ...barStyle,
        zIndex: isDragging ? 30 : (barStyle.zIndex as number | undefined),
        ...dragTransform,
      }}
      title={onEdit ? `${tooltip} (click for details, drag to move)` : tooltip}
    >
      {children}
    </button>
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
          className="border-l-4 border-l-blue"
          label="Pending"
        />
      </div>
      <p className="text-fg-subtle">
        Read-only overview of today&apos;s rentals and work blocks.
        Manage them from the Schedule and Work Log pages.
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
