"use client";

// Programs schedule grid for a single day (SCR-1a / QA10 W3.8a). A SINGLE
// combined "Programs" timeline — one shared time axis (8 AM – 10 PM, 30-min
// columns) with DYNAMIC lane-stacking: non-overlapping blocks share one
// compact lane row; overlapping blocks split into as many stacked lanes as
// the concurrency needs. Each bar's primary label is the PROGRAM name (not
// the coach); the reconciliation status color + small status label stay.
// Interactions:
//   - Click an empty timeline cell → create dialog with the clicked time
//     prefilled but NO program preselected (admin picks the program there).
//   - Click a block bar → edit dialog (edit + delete).
//   - Drag a block bar → updateProgramScheduleBlock with a new start time,
//     preserving the block's duration (and its program/coaches/resources/
//     note — the update action leaves any field omitted from the payload
//     untouched, and moves linked cage blocked_times to the new time).
//     Touch-friendly via @dnd-kit's TouchSensor.

import { useState, useTransition } from "react";
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { assignLanes } from "@/lib/schedule-lanes";
import {
  PROGRAM_GRID_SLOTS,
  placeOnGrid15,
  slotStartAt15,
} from "@/lib/schedule-grid-utils";
import { updateProgramScheduleBlock } from "../actions";
import {
  pfaHour,
  pfaMinute,
  pfaWallClockAt,
  formatPfaTime,
} from "@/lib/timezone";
import type {
  BlockReconciliation,
  BlockStatus,
} from "@/lib/server/reconciliation";
import {
  ProgramBlockDialog,
  type CoachOption,
  type ProgramOption,
  type ResourceOption,
  type SeriesView,
} from "./program-block-dialog";

const FIRST_HOUR = 8;
const LAST_HOUR = 22;
// #8: programs use 15-min resolution → 56 slots over the same 8 AM–10 PM
// window (cage grids keep the 28 half-hour slots). 4 slots = 1 hour.
const SLOTS = PROGRAM_GRID_SLOTS; // 56

export type ProgramScheduleBlockView = {
  id: string;
  programId: string;
  scheduledCoachId: string;
  coachName: string;
  // QA10 W3.2: the FULL scheduled-coach set (first = primary). The bar
  // shows the primary name + "+N" when length > 1.
  coaches: { id: string; name: string }[];
  startAt: Date;
  endAt: Date;
  note: string | null;
  // RECUR-b2: NULL for one-off blocks; the parent series id for a
  // materialized recurring occurrence.
  seriesId: string | null;
  // QA10 W3.3: the cage resources this block occupies (linked blocked_times).
  resourceIds: string[];
};

type CreatePrefill = {
  programId: string;
  startTime: string; // "HH:MM"
  endTime: string; // "HH:MM"
};

type DialogState =
  | { kind: "closed" }
  | { kind: "create"; prefill: CreatePrefill }
  | { kind: "edit"; block: ProgramScheduleBlockView };

// @dnd-kit serializes drag/drop `data`; ISO strings travel cleaner than
// Date objects. The droppable target is a slot COLUMN (lane-agnostic) —
// program blocks aren't pinned to a resource row, so any lane can receive
// the move and the server refresh re-stacks the lanes.
type BlockDragData = {
  type: "program-block";
  id: string;
  startAt: string; // ISO
  endAt: string; // ISO
};

type CellDropData = {
  type: "cell";
  slotIndex: number;
};

// Maps a reconciliation status → the bar's left-accent + bg-tint classes
// and the tiny status-label text. `pending`/missing use the neutral blue
// work-block accent (#22/#24: blue = work, distinct from gold cages). All
// token colors are AA-safe per globals.css.
const STATUS_LABELS: Record<BlockStatus, string> = {
  logged: "On schedule",
  wrong_coach: "Wrong coach",
  wrong_time: "Wrong time",
  no_show: "No-show",
  pending: "Pending",
};

function statusAccent(status: BlockStatus | undefined): string {
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

function statusTextColor(status: BlockStatus | undefined): string {
  switch (status) {
    case "logged":
      return "text-success";
    case "wrong_coach":
    case "wrong_time":
    case "no_show":
      return "text-danger";
    default:
      return "text-fg-subtle";
  }
}

export function ProgramScheduleGrid({
  programs,
  coaches,
  resources,
  blocks,
  seriesById,
  selectedDate,
  statuses,
}: {
  programs: ProgramOption[];
  coaches: CoachOption[];
  // QA10 W3.3: active cage resources for the occupancy picker.
  resources: ResourceOption[];
  blocks: ProgramScheduleBlockView[];
  // RECUR-b2: editable series definitions keyed by series id, for any
  // occurrence visible on this day.
  seriesById: Record<string, SeriesView>;
  selectedDate: Date;
  statuses: Record<string, BlockReconciliation>;
}) {
  const [dialog, setDialog] = useState<DialogState>({ kind: "closed" });
  const [dragError, setDragError] = useState<string | null>(null);
  const [draggingBlockId, setDraggingBlockId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const close = () => setDialog({ kind: "closed" });

  // distance: 5 lets short clicks through as clicks (click-to-edit keeps
  // working); only after the pointer moves 5px does @dnd-kit activate a
  // drag. Touch has a small delay so scrolling on a touchscreen still works.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 5 },
    }),
  );

  // Drag-to-MOVE: read the dragged block's [startAt, endAt) to get its
  // duration, derive the new start from the dropped slot index, keep the
  // duration, and persist. The update action leaves program/coaches/
  // resources/note untouched when those fields are omitted, and propagates
  // any linked cage blocked_times to the new time — so we send ONLY the
  // times. Snap-back on error is automatic (revalidate doesn't re-render on
  // throw, and the dnd-kit transform clears on dragEnd).
  const handleDragEnd = (event: DragEndEvent) => {
    setDraggingBlockId(null);
    const { active, over } = event;
    if (!over) return;

    const blockData = active.data.current as BlockDragData | undefined;
    const dropData = over.data.current as CellDropData | undefined;
    if (blockData?.type !== "program-block" || dropData?.type !== "cell") {
      return;
    }

    const oldStart = new Date(blockData.startAt);
    const oldEnd = new Date(blockData.endAt);
    const durationMs = oldEnd.getTime() - oldStart.getTime();

    const newStart = slotStartAt15(selectedDate, dropData.slotIndex);
    const newEnd = new Date(newStart.getTime() + durationMs);

    // No-op if dropped on the same start slot.
    if (newStart.getTime() === oldStart.getTime()) return;

    startTransition(async () => {
      try {
        await updateProgramScheduleBlock(blockData.id, {
          startAt: newStart,
          endAt: newEnd,
        });
        setDragError(null);
      } catch (err) {
        const message =
          err instanceof Error && err.message
            ? err.message
            : "Couldn't move that block. Try a different time.";
        setDragError(message);
        setTimeout(() => setDragError(null), 6_000);
      }
    });
  };

  // QA10 W3.8a: empty-cell create no longer preselects a program — the admin
  // picks it in the dialog. Prefill carries only the clicked time.
  const openCreateAt = (slotIdx: number) => {
    // 15-min slot start (slot 0 = 8:00, slot 1 = 8:15, …); default a 1-hour
    // duration prefilled in the dialog (admin can edit to any time there).
    const start = slotStartAt15(selectedDate, slotIdx);
    const end = pfaWallClockAt(
      selectedDate,
      pfaHour(start) + 1,
      pfaMinute(start),
    );
    setDialog({
      kind: "create",
      prefill: {
        programId: "",
        startTime: formatPfaTime(start),
        endTime: formatPfaTime(end),
      },
    });
  };

  const openEdit = (block: ProgramScheduleBlockView) => {
    setDialog({ kind: "edit", block });
  };

  const programNameById = new Map(programs.map((p) => [p.id, p.name]));

  const inRange = (when: Date) =>
    pfaHour(when) >= FIRST_HOUR && pfaHour(when) < LAST_HOUR;
  const visibleBlocks = blocks.filter((b) => inRange(b.startAt));
  const hiddenCount = blocks.length - visibleBlocks.length;

  // QA10 W3.8a: dynamic lane-stacking across ALL visible blocks. Lane index
  // → grid row (lane + 2; header is row 1). Always render at least 1 lane
  // row so the empty-timeline cells still show + stay clickable.
  const { laneByBlockId, laneCount } = assignLanes(
    visibleBlocks.map((b) => ({
      id: b.id,
      startAt: b.startAt,
      endAt: b.endAt,
    })),
  );
  const laneRows = Math.max(laneCount, 1);

  // QA10 W3.8a: occupancy is now by TIME (not per program). A slot column is
  // occupied if ANY visible block covers it, so empty-cell clicks only land
  // on free time. Keyed by slot index.
  //
  // Skip the actively-dragged block's own footprint so its current slots
  // stay droppable (a small shift within its own span would otherwise be
  // impossible — mirrors the cage grid's draggingSessionId exclusion).
  const occupiedSlots = new Set<number>();
  for (const b of visibleBlocks) {
    if (b.id === draggingBlockId) continue;
    const placement = placeOnGrid15(b.startAt, b.endAt);
    if (!placement) continue;
    for (let i = 0; i < placement.span; i++) {
      occupiedSlots.add(placement.col - 1 + i);
    }
  }

  const gridStyle: React.CSSProperties = {
    // 56 fifteen-min columns; half the per-cell min width of the 30-min grid
    // so the total width stays comparable.
    gridTemplateColumns: `repeat(${SLOTS}, minmax(18px, 1fr))`,
    gridTemplateRows: `40px repeat(${laneRows}, 56px)`,
  };

  return (
    <DndContext
      sensors={sensors}
      onDragStart={(e) => setDraggingBlockId(String(e.active.id))}
      onDragCancel={() => setDraggingBlockId(null)}
      onDragEnd={handleDragEnd}
    >
    <div className="space-y-3">
      {hiddenCount > 0 ? (
        <div
          role="status"
          className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning"
        >
          {hiddenCount} {hiddenCount === 1 ? "block is" : "blocks are"} outside
          the 8 AM – 10 PM range and not shown here.
        </div>
      ) : null}

      {dragError ? (
        <div
          role="alert"
          className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger flex items-start justify-between gap-2"
        >
          <span>{dragError}</span>
          <button
            type="button"
            onClick={() => setDragError(null)}
            className="text-danger/70 hover:text-danger text-[10px] uppercase tracking-wider"
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {programs.length === 0 ? (
        <div
          role="status"
          className="rounded-md border border-line bg-surface-2 px-3 py-6 text-center text-sm text-fg-muted"
        >
          No active programs yet. Create a program first to schedule it.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line shadow-[var(--shadow-sm)]">
          <div className="relative grid bg-surface min-w-fit" style={gridStyle}>
            {/* Time-slot headers. */}
            {Array.from({ length: SLOTS }).map((_, slotIdx) => {
              const col = slotIdx + 1;
              // 4 fifteen-min slots = 1 hour: label + strong divider on the
              // hour boundary (slotIdx % 4 === 0), faint dividers in between.
              const isHour = slotIdx % 4 === 0;
              const hour24 = FIRST_HOUR + Math.floor(slotIdx / 4);
              return (
                <div
                  key={`h-${slotIdx}`}
                  className={[
                    "border-b border-line text-[10px] uppercase tracking-wider text-fg-muted",
                    "flex items-end pb-1.5 pl-1",
                    isHour
                      ? "border-l border-line-strong"
                      : "border-l border-line/40",
                  ].join(" ")}
                  style={{ gridRow: 1, gridColumn: col }}
                >
                  {isHour ? formatHour(hour24) : ""}
                </div>
              );
            })}

            {/* Cells — one per (lane row × slot), clickable when the slot's
                time is not covered by any block. Occupied cells skip the
                click so the bar above wins it. */}
            {Array.from({ length: laneRows }).map((_, laneIdx) =>
              Array.from({ length: SLOTS }).map((_, slotIdx) => (
                <DroppableCell
                  key={`cell-${laneIdx}-${slotIdx}`}
                  laneIdx={laneIdx}
                  slotIdx={slotIdx}
                  isOccupied={occupiedSlots.has(slotIdx)}
                  isDragging={draggingBlockId !== null}
                  onCreate={() => openCreateAt(slotIdx)}
                />
              )),
            )}

            {/* Block bars. QA10 W3.8a: row = the block's assigned lane + 2
                (header is row 1); primary label = the PROGRAM name. */}
            {visibleBlocks.map((b) => {
              const lane = laneByBlockId.get(b.id);
              if (lane === undefined) return null;
              const placement = placeOnGrid15(b.startAt, b.endAt);
              if (!placement) return null;
              const recon = statuses[b.id];
              const status = recon?.status;
              const timeLabel = `${formatPfaTime(b.startAt)}–${formatPfaTime(
                b.endAt,
              )}`;
              const programLabel =
                programNameById.get(b.programId) ?? b.programId;
              // Coach names move OFF the bar into the tooltip (W3.2 set).
              const allCoachNames =
                b.coaches.length > 1
                  ? b.coaches.map((c) => c.name).join(", ")
                  : b.coachName;
              // Tooltip leads with the program name, then coach(es)/time/etc.
              const tooltip = [
                programLabel,
                allCoachNames,
                timeLabel,
                b.note,
                recon?.detail,
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <DraggableBlock
                  key={`block-${b.id}`}
                  block={b}
                  row={lane + 2}
                  placement={placement}
                  accentClass={statusAccent(status)}
                  title={`${tooltip} (click to edit or drag to move)`}
                  programLabel={programLabel}
                  timeLabel={timeLabel}
                  status={status}
                  onEdit={() => openEdit(b)}
                />
              );
            })}
          </div>
        </div>
      )}

      <div className="space-y-2 text-[11px] text-fg-muted">
        <p className="text-[11px] text-fg-subtle md:hidden">
          Scroll the schedule sideways to see all times.
        </p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <LegendDot className="bg-success" label="On schedule" />
          <LegendDot className="bg-danger" label="Wrong coach" />
          <LegendDot className="bg-danger" label="Wrong time" />
          <LegendDot className="bg-danger" label="No-show" />
          <LegendDot className="bg-blue" label="Pending" />
        </div>
        <p className="text-fg-subtle">
          Click an empty area to schedule a program block (pick the program in
          the dialog). Click a block to edit or delete it, or drag it to a new
          time (its length is kept). Each bar shows the program, time, and
          reconciliation status (how the logged hours compare to the schedule);
          the scheduled coach(es) appear in the tooltip and the edit dialog.
        </p>
      </div>

      <ProgramBlockDialog
        open={dialog.kind !== "closed"}
        mode={dialog.kind === "edit" ? "edit" : "create"}
        onClose={close}
        date={selectedDate}
        programs={programs}
        coaches={coaches}
        resources={resources}
        createPrefill={dialog.kind === "create" ? dialog.prefill : null}
        reconciliation={
          dialog.kind === "edit" ? (statuses[dialog.block.id] ?? null) : null
        }
        editInitial={
          dialog.kind === "edit"
            ? {
                id: dialog.block.id,
                programId: dialog.block.programId,
                scheduledCoachId: dialog.block.scheduledCoachId,
                scheduledCoachIds: dialog.block.coaches.map((c) => c.id),
                startAt: dialog.block.startAt,
                endAt: dialog.block.endAt,
                note: dialog.block.note,
                seriesId: dialog.block.seriesId,
                resourceIds: dialog.block.resourceIds,
              }
            : null
        }
        editSeriesInitial={
          dialog.kind === "edit" && dialog.block.seriesId
            ? (seriesById[dialog.block.seriesId] ?? null)
            : null
        }
      />
    </div>
    </DndContext>
  );
}

// A single timeline cell: droppable for drag-to-move and clickable to
// create when its slot time is free. The droppable target is the slot
// COLUMN (lane-agnostic) — program blocks aren't pinned to a row, so any
// lane in the column accepts the move; the server refresh re-stacks lanes.
// Occupied cells aren't droppable (a block already covers that time) and
// skip the click so the bar above wins it.
function DroppableCell({
  laneIdx,
  slotIdx,
  isOccupied,
  isDragging,
  onCreate,
}: {
  laneIdx: number;
  slotIdx: number;
  isOccupied: boolean;
  isDragging: boolean;
  onCreate: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `drop-${laneIdx}-${slotIdx}`,
    data: { type: "cell", slotIndex: slotIdx } as CellDropData,
    disabled: isOccupied,
  });

  const baseBorders =
    slotIdx % 4 === 0
      ? "border-l border-line-strong"
      : "border-l border-line/40";

  return (
    <button
      ref={setNodeRef}
      type="button"
      onClick={isOccupied ? undefined : onCreate}
      disabled={isOccupied}
      tabIndex={isOccupied ? -1 : 0}
      aria-label={
        isOccupied
          ? undefined
          : `Schedule a program at ${formatHour(
              FIRST_HOUR + Math.floor(slotIdx / 4),
            )}${
              slotIdx % 4 !== 0
                ? `:${String((slotIdx % 4) * 15).padStart(2, "0")}`
                : ""
            }`
      }
      className={[
        "border-b border-line text-left",
        baseBorders,
        isOccupied
          ? "cursor-default bg-surface-2/40"
          : isDragging
            ? isOver
              ? "bg-gold/20"
              : "bg-page/40"
            : "bg-surface-2/40 transition-colors hover:bg-gold/5 focus-visible:outline-none focus-visible:bg-gold/10",
      ].join(" ")}
      style={{ gridRow: laneIdx + 2, gridColumn: slotIdx + 1 }}
    />
  );
}

// A program block bar: draggable to MOVE (keeps duration) and clickable to
// edit. distance:5 on the PointerSensor lets a plain click still fire
// openEdit; only a 5px drag activates the move.
function DraggableBlock({
  block,
  row,
  placement,
  accentClass,
  title,
  programLabel,
  timeLabel,
  status,
  onEdit,
}: {
  block: ProgramScheduleBlockView;
  row: number;
  placement: { col: number; span: number };
  accentClass: string;
  title: string;
  programLabel: string;
  timeLabel: string;
  status: BlockStatus | undefined;
  onEdit: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({
      id: block.id,
      data: {
        type: "program-block",
        id: block.id,
        startAt: block.startAt.toISOString(),
        endAt: block.endAt.toISOString(),
      } as BlockDragData,
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
      className={[
        "m-0.5 rounded-md border border-line px-2 py-1 text-[11px] text-fg shadow-[var(--shadow-sm)]",
        "flex flex-col justify-center min-w-0 text-left border-l-4",
        accentClass,
        "transition hover:shadow-[var(--shadow-md)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40",
        isDragging ? "opacity-40 cursor-grabbing" : "cursor-grab",
      ].join(" ")}
      style={{
        gridRow: row,
        gridColumn: `${placement.col} / span ${placement.span}`,
        zIndex: isDragging ? 30 : 2,
        ...dragTransform,
      }}
      title={title}
    >
      <span className="truncate font-medium">{programLabel}</span>
      <span className="truncate text-[9px] uppercase tracking-wider text-fg-subtle">
        {timeLabel}
      </span>
      {status ? (
        <span
          className={`truncate text-[9px] uppercase tracking-wider font-medium ${statusTextColor(
            status,
          )}`}
        >
          {STATUS_LABELS[status]}
        </span>
      ) : null}
    </button>
  );
}

function LegendDot({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden
        className={`h-2.5 w-2.5 rounded-full ${className}`}
      />
      <span>{label}</span>
    </span>
  );
}

function formatHour(hour24: number): string {
  if (hour24 === 0) return "12 AM";
  if (hour24 === 12) return "12 PM";
  if (hour24 < 12) return `${hour24} AM`;
  return `${hour24 - 12} PM`;
}
