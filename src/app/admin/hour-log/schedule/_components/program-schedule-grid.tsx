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

import { useEffect, useRef, useState, useTransition } from "react";
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
import { pfaHour, formatPfaTime } from "@/lib/timezone";
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
// #8: program BARS place on a 15-min track (56 columns) so master-schedule
// alignment + true-precision bars are preserved. The clickable empty-cell
// layer + visible gridlines are 30-min, though: 28 cells, each spanning 2 of
// the underlying 15-min columns. A "slotIdx" in the cell/click/drag/paint
// layer is therefore a 0..27 30-MIN index; multiply by 2 to get a 15-min
// coordinate when a real timestamp is computed.
const SLOTS = PROGRAM_GRID_SLOTS; // 56 (15-min columns; bars place here)
const CELL_SLOTS = PROGRAM_GRID_SLOTS / 2; // 28 (30-min clickable cells)

export type ProgramScheduleBlockView = {
  id: string;
  programId: string;
  // QA-R2 #10: null + "Unassigned" name when the block has no coach.
  scheduledCoachId: string | null;
  coachName: string;
  // QA10 W3.2: the FULL scheduled-coach set (first = primary). The bar
  // shows the primary name + "+N" when length > 1.
  // QA-R2 #10: EMPTY when the block has no coach.
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

// #15 drag-to-CREATE ("paint"). Coexists with the dnd-kit drag-to-MOVE on
// block bars: pressing an EMPTY cell records an anchor; if the pointer then
// moves >5px we enter paint mode and drag across the time axis to define a
// range; a sub-5px press that releases falls through to the normal
// click-to-create (1-hour default). Programs aren't pinned to a resource
// row (they lane-stack), so the anchor is just a slot index + the lane row
// pressed (used only to position the highlight overlay).
type PaintState =
  | { kind: "idle" }
  | {
      kind: "active";
      laneIdx: number;
      // Inclusive endpoints; start can exceed end while painting leftward.
      // Commit normalizes to min..max.
      startSlot: number;
      endSlot: number;
    };

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
  const [paint, setPaint] = useState<PaintState>({ kind: "idle" });
  const [, startTransition] = useTransition();

  // Holds the pointerdown anchor between pointerdown and the first
  // pointermove that crosses the 5px activation threshold. A ref so we
  // don't re-render on every pointermove.
  const paintStartRef = useRef<{
    laneIdx: number;
    slotIdx: number;
    x: number;
    y: number;
  } | null>(null);
  // Set when paint activated for the current pointer cycle, so the cell's
  // onClick (which fires AFTER pointerup) skips its single-cell create.
  const suppressNextClickRef = useRef(false);
  // The grid DOM node — used by the paint pointermove handler to convert
  // clientX into a slot index via getBoundingClientRect. (elementFromPoint
  // would be wrong: block bars sit above the cells, so painting across them
  // would lose the underlying slot — geometry math doesn't care.)
  const gridRef = useRef<HTMLDivElement | null>(null);

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

  // Latest-ref pattern: the window-level pointer handlers (paint) are bound
  // once on mount but need the freshest state. These refs sync in a no-dep
  // post-commit effect below; the handler closures read .current so they
  // never see stale React state. (`occupiedSlotsRef`/`selectedDateRef` are
  // assigned later, after those values are computed in render.)
  const paintRef = useRef(paint);
  const occupiedSlotsRef = useRef<Set<number>>(new Set());
  const selectedDateRef = useRef(selectedDate);

  // Convert pointer.clientX → a 30-min CELL slot index (0..27) by measuring
  // the grid's bounding rect. The program grid template is `repeat(56,
  // minmax(18px, 1fr))` with NO leading label column, so the whole rect width
  // maps linearly onto the 28 half-hour cells (unlike the cage grid's 120px
  // label offset). Paint/drop endpoints decode to 15-min coords via *2.
  const slotIndexFromClientX = (clientX: number): number | null => {
    const grid = gridRef.current;
    if (!grid) return null;
    const rect = grid.getBoundingClientRect();
    if (clientX < rect.left) return 0;
    if (clientX >= rect.right) return CELL_SLOTS - 1;
    const idx = Math.floor(((clientX - rect.left) / rect.width) * CELL_SLOTS);
    return Math.max(0, Math.min(CELL_SLOTS - 1, idx));
  };

  const handleCellPointerDown = (
    laneIdx: number,
    slotIdx: number,
    e: React.PointerEvent<HTMLButtonElement>,
  ) => {
    if (e.button !== 0) return; // left click only
    // Clear any stale suppress flag from a previous gesture whose trailing
    // click never landed (dialog took focus, pointer elsewhere, etc.).
    suppressNextClickRef.current = false;
    paintStartRef.current = { laneIdx, slotIdx, x: e.clientX, y: e.clientY };
  };

  const handleCellClick = (onCreate: () => void) => {
    // A paint just committed in pointerup → swallow the trailing click so we
    // don't ALSO open the single-cell (1-hour) create dialog.
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }
    onCreate();
  };

  // Window-level pointer handlers for paint mode. Bound once on mount; all
  // dynamic data flows through refs (latest-ref pattern).
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const start = paintStartRef.current;
      if (!start) return;

      const current = paintRef.current;
      // Cross the 5px activation threshold → enter paint mode.
      if (current.kind === "idle") {
        const dx = Math.abs(e.clientX - start.x);
        const dy = Math.abs(e.clientY - start.y);
        if (dx <= 5 && dy <= 5) return;
        suppressNextClickRef.current = true;
        setPaint({
          kind: "active",
          laneIdx: start.laneIdx,
          startSlot: start.slotIdx,
          endSlot: start.slotIdx,
        });
        return;
      }

      // Already painting — update endSlot to the pointer's 30-min cell,
      // clamped at the first OCCUPIED cell between startSlot and the pointer
      // so you can't paint across an existing block. `occupied` is keyed by
      // 15-min slot, so a 30-min cell `i` is occupied if EITHER sub-slot is.
      const targetSlot = slotIndexFromClientX(e.clientX);
      if (targetSlot === null) return;
      const occupied = occupiedSlotsRef.current;
      const cellOccupied = (cell: number) =>
        occupied.has(cell * 2) || occupied.has(cell * 2 + 1);
      const dir = targetSlot >= current.startSlot ? 1 : -1;
      let clampedEnd = current.startSlot;
      for (
        let i = current.startSlot + dir;
        dir > 0 ? i <= targetSlot : i >= targetSlot;
        i += dir
      ) {
        if (cellOccupied(i)) break;
        clampedEnd = i;
      }
      if (clampedEnd !== current.endSlot) {
        setPaint({ ...current, endSlot: clampedEnd });
      }
    };

    const onUp = () => {
      const start = paintStartRef.current;
      paintStartRef.current = null;
      const current = paintRef.current;
      if (!start) return;

      if (current.kind === "active") {
        const min = Math.min(current.startSlot, current.endSlot);
        const max = Math.max(current.startSlot, current.endSlot);
        // min/max are 30-MIN cell indices → decode to the 15-min track via *2.
        // start = beginning of the first painted cell; end = end of the LAST
        // painted cell (end-exclusive 30-min → slotStartAt15 of (max+1)*2).
        const startAt = slotStartAt15(selectedDateRef.current, min * 2);
        const endAt = slotStartAt15(selectedDateRef.current, (max + 1) * 2);
        setDialog({
          kind: "create",
          prefill: {
            programId: "",
            startTime: formatPfaTime(startAt),
            endTime: formatPfaTime(endAt),
          },
        });
        setPaint({ kind: "idle" });
      }
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
    };
    // Bound once; everything dynamic flows through refs.
     
  }, []);

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

    // dropData.slotIndex is a 0..27 30-min cell index → decode via *2 so the
    // move snaps to a 30-min boundary. Duration is preserved.
    const newStart = slotStartAt15(selectedDate, dropData.slotIndex * 2);
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
  // picks it in the dialog. Prefill carries only the clicked time. The cell
  // layer is 30-min, so a single click defaults to a 30-MIN block (the
  // clicked cell); 15-min precision lives in the dialog's time dropdown.
  const openCreateAt = (slotIdx: number) => {
    // slotIdx is a 0..27 30-min cell index → decode to the 15-min track via
    // *2. start = cell start (cell 0 = 8:00, cell 1 = 8:30, …); end = +30 min.
    const start = slotStartAt15(selectedDate, slotIdx * 2);
    const end = slotStartAt15(selectedDate, slotIdx * 2 + 2);
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

  // Sync the latest-ref values for the window paint handlers. A no-dep
  // effect runs post-commit every render so the once-bound listeners read
  // fresh state without re-binding. (Assigning during render would be impure
  // and is flagged by react-hooks in React 19.)
  useEffect(() => {
    paintRef.current = paint;
    occupiedSlotsRef.current = occupiedSlots;
    selectedDateRef.current = selectedDate;
  });

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
          <div
            ref={gridRef}
            className="relative grid bg-surface min-w-fit"
            style={gridStyle}
          >
            {/* Time-slot headers — one per 30-MIN cell (28), each spanning 2
                of the underlying 15-min columns. Strong divider every 30 min;
                hour-boundary cells carry the hour label, half-hour cells are
                blank (no faint 15-min sub-lines). */}
            {Array.from({ length: CELL_SLOTS }).map((_, slotIdx) => {
              // 2 thirty-min cells = 1 hour: label + (already strong) divider
              // on the hour boundary (slotIdx % 2 === 0).
              const isHour = slotIdx % 2 === 0;
              const hour24 = FIRST_HOUR + Math.floor(slotIdx / 2);
              return (
                <div
                  key={`h-${slotIdx}`}
                  className={[
                    "border-b border-line text-[10px] uppercase tracking-wider text-fg-muted",
                    "flex items-end pb-1.5 pl-1",
                    "border-l border-line-strong",
                  ].join(" ")}
                  style={{
                    gridRow: 1,
                    gridColumn: `${slotIdx * 2 + 1} / span 2`,
                  }}
                >
                  {isHour ? formatHour(hour24) : ""}
                </div>
              );
            })}

            {/* Cells — one per (lane row × 30-MIN cell), clickable when the
                cell's time is not covered by any block. A 30-min cell is
                occupied if EITHER of its 15-min sub-slots is taken. Occupied
                cells skip the click so the bar above wins it. */}
            {Array.from({ length: laneRows }).map((_, laneIdx) =>
              Array.from({ length: CELL_SLOTS }).map((_, slotIdx) => (
                <DroppableCell
                  key={`cell-${laneIdx}-${slotIdx}`}
                  laneIdx={laneIdx}
                  slotIdx={slotIdx}
                  isOccupied={
                    occupiedSlots.has(slotIdx * 2) ||
                    occupiedSlots.has(slotIdx * 2 + 1)
                  }
                  isDragging={draggingBlockId !== null}
                  onCreate={() => openCreateAt(slotIdx)}
                  onPointerDown={handleCellPointerDown}
                  onClickWrapped={handleCellClick}
                />
              )),
            )}

            {/* Paint highlight — a blue dashed overlay (work = blue) across
                the painted slot range in the pressed lane row, while active. */}
            {paint.kind === "active"
              ? (() => {
                  // min/max are 30-min cell indices → map onto the underlying
                  // 15-min columns via *2 (each cell = 2 columns wide).
                  const min = Math.min(paint.startSlot, paint.endSlot);
                  const max = Math.max(paint.startSlot, paint.endSlot);
                  return (
                    <div
                      aria-hidden
                      style={{
                        gridRow: paint.laneIdx + 2,
                        gridColumn: `${min * 2 + 1} / span ${
                          (max - min + 1) * 2
                        }`,
                        pointerEvents: "none",
                        zIndex: 5,
                      }}
                      className="m-0.5 rounded border-2 border-dashed border-blue/80 bg-blue/15"
                    />
                  );
                })()
              : null}

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
          Click an empty area to schedule a program block, or drag across empty
          time to set the range (pick the program in the dialog). Click a block
          to edit or delete it, or drag it to a new time (its length is kept).
          Each bar shows the program, time, and
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
  onPointerDown,
  onClickWrapped,
}: {
  laneIdx: number;
  slotIdx: number;
  isOccupied: boolean;
  isDragging: boolean;
  onCreate: () => void;
  onPointerDown: (
    laneIdx: number,
    slotIdx: number,
    e: React.PointerEvent<HTMLButtonElement>,
  ) => void;
  onClickWrapped: (onCreate: () => void) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `drop-${laneIdx}-${slotIdx}`,
    data: { type: "cell", slotIndex: slotIdx } as CellDropData,
    disabled: isOccupied,
  });

  // Strong vertical divider on every 30-min cell boundary.
  const baseBorders = "border-l border-line-strong";

  return (
    <button
      ref={setNodeRef}
      type="button"
      onClick={isOccupied ? undefined : () => onClickWrapped(onCreate)}
      onPointerDown={
        isOccupied ? undefined : (e) => onPointerDown(laneIdx, slotIdx, e)
      }
      disabled={isOccupied}
      tabIndex={isOccupied ? -1 : 0}
      aria-label={
        isOccupied
          ? undefined
          : `Schedule a program at ${formatCellTime(slotIdx)}`
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
      style={{
        gridRow: laneIdx + 2,
        gridColumn: `${slotIdx * 2 + 1} / span 2`,
      }}
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

// "4:00 PM" / "4:30 PM" for a 0..27 30-min cell index — used in cell
// aria-labels so the 30-min cadence is announced (not :15/:45).
function formatCellTime(cellIdx: number): string {
  const hour24 = FIRST_HOUR + Math.floor(cellIdx / 2);
  const minutes = cellIdx % 2 === 0 ? "00" : "30";
  const hour12 = hour24 === 0 ? 12 : hour24 > 12 ? hour24 - 12 : hour24;
  const meridiem = hour24 < 12 || hour24 === 24 ? "AM" : "PM";
  return `${hour12}:${minutes} ${meridiem}`;
}
