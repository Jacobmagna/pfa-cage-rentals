"use client";

// QA10 W3.6 (#3) — the editable Home Master Schedule. Wraps the read-only,
// presentational MasterScheduleGrid and turns its empty cells into a
// click-to-add surface that reuses the EXISTING dialogs:
//   - empty CAGE cell  → ScheduleCreateDialog (the /admin/schedule add dialog)
//   - empty PROGRAM cell → ProgramBlockDialog in CREATE mode (the
//     /admin/hour-log/schedule dialog, now W3.1 recurrence + W3.2 multi-coach
//     + W3.3 resource-occupancy).
// We own only the dialog state + prefill math here; the dialogs' server
// actions revalidate their own paths, and on close we router.refresh() so the
// new item appears on the server-rendered Home grid. The grid file itself
// imports no dialogs — the onEmptyCellClick handler is passed in from here.

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  MasterScheduleGrid,
  inRange,
  type BlockClick,
  type EmptyCellClick,
  type MasterBlockedTime,
  type MasterCellDropData,
  type MasterProgramBlock,
  type MasterProgramBlockDragData,
  type MasterProgramRow,
  type MasterResourceRow,
  type MasterSession,
  type MasterSessionDragData,
  type PaintOverlay,
  type PaintPointerDown,
} from "./master-schedule-grid";
import { updateSession } from "@/app/admin/sessions/actions";
import { updateProgramScheduleBlock } from "@/app/admin/hour-log/schedule/actions";
import {
  ScheduleCreateDialog,
  type CreatePrefill,
} from "@/app/admin/schedule/_components/schedule-create-dialog";
import type {
  CoachOption as CageCoachOption,
  ResourceOption as CageResourceOption,
} from "@/app/admin/sessions/_components/sessions-client";
import {
  SessionFormDialog,
  type SessionFormInitialValues,
} from "@/app/admin/sessions/_components/session-form-dialog";
import {
  BlockEditDialog,
  type BlockEditInitialValues,
} from "@/app/admin/schedule/_components/block-edit-dialog";
import {
  ProgramBlockDialog,
  type CoachOption as ProgramCoachOption,
  type ProgramBlockEditInitial,
  type ProgramOption,
  type ResourceOption as ProgramResourceOption,
  type SeriesView,
} from "@/app/admin/hour-log/schedule/_components/program-block-dialog";
import type { BlockReconciliation } from "@/lib/server/reconciliation";
import {
  SCHEDULE_GRID_SLOTS,
  placeOnGrid,
  placeOnGrid15,
  slotStartAt,
  slotStartAt15,
} from "@/lib/schedule-grid-utils";
import { assignLanes } from "@/lib/schedule-lanes";
import { formatPfaTime } from "@/lib/timezone";

// Drag id prefix (e.g. "session-…" / "program-block-…") → bare entity id, so
// the grid's draggingId prop (which excludes the dragged item's own footprint
// from the occupied set) can compare against the plain MasterSession.id /
// MasterProgramBlock.id. The draggable ids are namespaced to avoid collisions.
function bareDragId(activeId: string): string {
  if (activeId.startsWith("session-")) return activeId.slice("session-".length);
  if (activeId.startsWith("program-block-")) {
    return activeId.slice("program-block-".length);
  }
  return activeId;
}

type ProgramCreatePrefill = {
  programId: string;
  startTime: string;
  endTime: string;
};

type DialogState =
  | { kind: "closed" }
  | { kind: "cage"; prefill: CreatePrefill }
  | { kind: "program"; prefill: ProgramCreatePrefill }
  // QA10 W3.9: click an existing bar → open its edit dialog, seeded by id
  // from the enriched maps below.
  | { kind: "edit-session"; id: string }
  | { kind: "edit-block"; id: string }
  | { kind: "edit-program"; id: string };

export function EditableMasterSchedule({
  // Grid data (same as the read-only grid).
  resources,
  sessions,
  blockedTimes,
  programs,
  programBlocks,
  // Selected day — drives the prefill start/end times.
  selectedDate,
  // Cage dialog deps (sessions-client shapes).
  cageCoaches,
  cageResources,
  // Program dialog deps (program-block-dialog shapes).
  programOptions,
  programCoaches,
  programResources,
  // QA10 W3.9: edit-dialog seed data, keyed by entity id.
  sessionEditById,
  blockEditById,
  programEditById,
  seriesById,
  reconciliation,
}: {
  resources: MasterResourceRow[];
  sessions: MasterSession[];
  blockedTimes: MasterBlockedTime[];
  programs: MasterProgramRow[];
  programBlocks: MasterProgramBlock[];
  selectedDate: Date;
  cageCoaches: CageCoachOption[];
  cageResources: CageResourceOption[];
  programOptions: ProgramOption[];
  programCoaches: ProgramCoachOption[];
  programResources: ProgramResourceOption[];
  sessionEditById: Record<string, SessionFormInitialValues>;
  blockEditById: Record<string, BlockEditInitialValues>;
  programEditById: Record<string, ProgramBlockEditInitial>;
  seriesById: Record<string, SeriesView>;
  reconciliation: Record<string, BlockReconciliation>;
}): React.JSX.Element {
  const router = useRouter();
  const [dialog, setDialog] = useState<DialogState>({ kind: "closed" });

  // #15B drag-to-MOVE. A SINGLE DndContext spans BOTH grid sections even
  // though they have different granularities (cage = 30-min, program = 15-min)
  // and different server actions. The droppable cells carry their section +
  // slot index in their data, so handleDragEnd reads the section off the DROP
  // target and picks the matching slot→time helper; it reads the entity kind
  // off the DRAG source to pick the action. No pointer-X math is needed.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragError, setDragError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // distance:5 lets a plain click through (→ edit/create) while a >5px drag
  // becomes a move. Touch gets a short delay so list scrolling still works.
  // Mirrors the cage schedule grid exactly.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 5 },
    }),
  );

  // ── #15 drag-to-CREATE ("paint") ──────────────────────────────────────────
  // Press on an empty cell and drag across a time range → on release a create
  // dialog opens prefilled with that start→end range. Mirrors the proven cage
  // schedule-grid paint pattern, made SECTION-AWARE for the master grid's two
  // granularities (cage = 30-min / 28 slots, program = 15-min / 56 slots), each
  // with its own 120px label column. The single source of slot resolution is
  // slotIndexFromClientX, which measures the SECTION'S OWN grid node.
  //
  // paintOverlay drives the dashed highlight (null = not painting); it carries
  // the section so the matching sub-grid renders it in the right place/color.
  const [paintOverlay, setPaintOverlay] = useState<PaintOverlay>(null);

  // Per-section grid DOM nodes, registered by the grid via registerGridNode, so
  // slotIndexFromClientX measures the correct bounding rect + slot count.
  const gridNodes = useRef<{
    resource: HTMLDivElement | null;
    program: HTMLDivElement | null;
  }>({ resource: null, program: null });
  const registerGridNode = (
    section: "resource" | "program",
    node: HTMLDivElement | null,
  ) => {
    gridNodes.current[section] = node;
  };

  // The pointerdown anchor, held between pointerdown and the first pointermove
  // that crosses the 5px activation threshold. A ref (no re-render per move).
  const paintStartRef = useRef<{
    section: "resource" | "program";
    rowId: string; // resourceId for cage; "" for program
    slotIndex: number;
    laneIdx?: number; // painted lane for the program section (per-lane occupancy)
    x: number;
    y: number;
  } | null>(null);
  // Set when paint activated this pointer cycle, so the trailing cell click
  // (fires AFTER pointerup) skips its single-cell create. Cleared on next click.
  const suppressNextClickRef = useRef(false);

  // Latest-ref pattern: the window pointer handlers are bound once but must see
  // the freshest props/state. Synced in a no-dep post-commit effect — assigning
  // to ref.current during render is impure (react-hooks/refs in React 19).
  const paintOverlayRef = useRef(paintOverlay);
  const sessionsRef = useRef(sessions);
  const blockedTimesRef = useRef(blockedTimes);
  const programBlocksRef = useRef(programBlocks);
  const selectedDateRef = useRef(selectedDate);
  useEffect(() => {
    paintOverlayRef.current = paintOverlay;
    sessionsRef.current = sessions;
    blockedTimesRef.current = blockedTimes;
    programBlocksRef.current = programBlocks;
    selectedDateRef.current = selectedDate;
  });

  // Is the given slot occupied in the painting section? Cage = per-resource
  // (sessions + blocked times on that resourceId); program = per-LANE (only a
  // block on THAT lane covering that 30-min column counts). Excludes nothing —
  // these are empty-cell paints, so any occupied slot is a hard stop.
  const isSlotOccupied = (
    section: "resource" | "program",
    rowId: string,
    slotIndex: number,
    laneIdx: number,
  ): boolean => {
    if (section === "resource") {
      for (const s of sessionsRef.current) {
        if (s.resourceId !== rowId) continue;
        const p = placeOnGrid(s.startAt, s.endAt);
        if (p && slotIndex >= p.col - 2 && slotIndex < p.col - 2 + p.span) {
          return true;
        }
      }
      for (const b of blockedTimesRef.current) {
        if (b.resourceId !== rowId) continue;
        const p = placeOnGrid(b.startAt, b.endAt);
        if (p && slotIndex >= p.col - 2 && slotIndex < p.col - 2 + p.span) {
          return true;
        }
      }
      return false;
    }
    // #8: the program paint layer is 30-min (slotIndex 0..27). A 30-min slot is
    // occupied on a lane if EITHER of its two 15-min sub-slots is covered by a
    // block ON THAT LANE. Occupancy is PER-LANE: recompute the same lane
    // assignment the child grid uses. CRITICAL: the child assigns lanes over
    // the SAME `inRange`-FILTERED (8AM–10PM) set it renders, so we must filter
    // here identically — else an out-of-range block that overlaps a visible one
    // shifts every later block's lane index and the laneIdx the child passed
    // would point at the wrong lane. assignLanes is deterministic over the same
    // filtered list, so the indices then align exactly.
    const visible = programBlocksRef.current.filter((b) => inRange(b.startAt));
    const { laneByBlockId } = assignLanes(
      visible.map((b) => ({ id: b.id, startAt: b.startAt, endAt: b.endAt })),
    );
    for (const b of visible) {
      if (laneByBlockId.get(b.id) !== laneIdx) continue;
      const p = placeOnGrid15(b.startAt, b.endAt);
      if (!p) continue;
      // placeOnGrid15.col is 1-based with NO leading label column (slot 0 →
      // col 1). Recover the 0-based 15-min slot range, then test both sub-slots
      // of the 30-min cell.
      const start15 = p.col - 1;
      const end15 = start15 + p.span; // exclusive
      const lo = slotIndex * 2;
      const hi = slotIndex * 2 + 1;
      if ((lo >= start15 && lo < end15) || (hi >= start15 && hi < end15)) {
        return true;
      }
    }
    return false;
  };

  // Map a pointer clientX to a slot index within `section`'s own grid. Both
  // sub-grids template "120px repeat(N, …)" — the first column is the label,
  // then N equal fractions fill the rest. #8: BOTH sections' paint layer is now
  // 30-min, so both resolve to 28 logical slots (0..27). The program grid node
  // still has 56 underlying template columns, but the 28 30-min cells span the
  // same total width as the cage section's 28, so we measure against 28 slots
  // and decode to the 15-min template via *2 elsewhere.
  const slotIndexFromClientX = (
    section: "resource" | "program",
    clientX: number,
  ): number | null => {
    const grid = gridNodes.current[section];
    if (!grid) return null;
    const slots = SCHEDULE_GRID_SLOTS;
    const rect = grid.getBoundingClientRect();
    const cellsLeft = rect.left + 120;
    const cellsWidth = rect.right - cellsLeft;
    if (cellsWidth <= 0) return null;
    if (clientX < cellsLeft) return 0;
    if (clientX >= rect.right) return slots - 1;
    const idx = Math.floor(((clientX - cellsLeft) / cellsWidth) * slots);
    return Math.max(0, Math.min(slots - 1, idx));
  };

  const handleCellPaintPointerDown: PaintPointerDown = ({
    section,
    rowId,
    slotIndex,
    laneIdx,
    clientX,
    clientY,
  }) => {
    // Clear any stale suppress flag from a prior gesture whose trailing click
    // never landed (dialog took focus, pointer moved off, etc.).
    suppressNextClickRef.current = false;
    paintStartRef.current = {
      section,
      rowId,
      slotIndex,
      laneIdx,
      x: clientX,
      y: clientY,
    };
  };

  // Wrap the single-cell create so a completed paint swallows the trailing
  // click (which fires AFTER pointerup) instead of ALSO opening the 1-slot
  // create dialog.
  const handleCellClickWrapped = (run: () => void) => {
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }
    run();
  };

  // Open the matching create dialog for a committed paint range. Reuses the
  // exact prefill shapes handleEmptyCellClick builds for a single empty cell.
  const openPaintCreate = (
    section: "resource" | "program",
    rowId: string,
    minSlot: number,
    maxSlot: number,
  ) => {
    const date = selectedDateRef.current;
    if (section === "resource") {
      const startAt = slotStartAt(date, minSlot);
      // maxSlot is inclusive → block runs through the END of slot maxSlot.
      const endAt = slotStartAt(date, maxSlot + 1);
      setDialog({
        kind: "cage",
        prefill: { resourceId: rowId, startAt, endAt },
      });
    } else {
      // #8: program paint slots are 30-min indices (0..27); maxSlot is
      // inclusive → the block runs through the END of slot maxSlot. Decode to
      // the 15-min template via *2 so the painted range snaps to 30-min.
      const startAt = slotStartAt15(date, minSlot * 2);
      const endAt = slotStartAt15(date, (maxSlot + 1) * 2);
      setDialog({
        kind: "program",
        prefill: {
          programId: rowId,
          startTime: formatPfaTime(startAt),
          endTime: formatPfaTime(endAt),
        },
      });
    }
  };

  // Window-level pointer handlers for paint. Bound once on mount; everything
  // dynamic flows through refs (latest-ref pattern).
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const start = paintStartRef.current;
      if (!start) return;
      const current = paintOverlayRef.current;

      // Cross the 5px activation threshold → enter paint mode.
      if (current === null) {
        const dx = Math.abs(e.clientX - start.x);
        const dy = Math.abs(e.clientY - start.y);
        if (dx <= 5 && dy <= 5) return;
        suppressNextClickRef.current = true;
        setPaintOverlay(
          start.section === "resource"
            ? {
                section: "resource",
                resourceId: start.rowId,
                minSlot: start.slotIndex,
                maxSlot: start.slotIndex,
              }
            : {
                section: "program",
                laneIdx: start.laneIdx ?? 0,
                minSlot: start.slotIndex,
                maxSlot: start.slotIndex,
              },
        );
        return;
      }

      // Already painting — extend toward the pointer, clamped at the first
      // occupied slot between the anchor and the pointer's slot.
      const targetSlot = slotIndexFromClientX(start.section, e.clientX);
      if (targetSlot === null) return;
      const anchor = start.slotIndex;
      const dir = targetSlot >= anchor ? 1 : -1;
      let clamped = anchor;
      for (
        let i = anchor + dir;
        dir > 0 ? i <= targetSlot : i >= targetSlot;
        i += dir
      ) {
        if (isSlotOccupied(start.section, start.rowId, i, start.laneIdx ?? 0))
          break;
        clamped = i;
      }
      // current is the active overlay; the anchor slot lives in start.slotIndex,
      // the moving end is `clamped`. Re-derive min/max for the highlight.
      const min = Math.min(anchor, clamped);
      const max = Math.max(anchor, clamped);
      if (current.minSlot !== min || current.maxSlot !== max) {
        setPaintOverlay(
          start.section === "resource"
            ? {
                section: "resource",
                resourceId: start.rowId,
                minSlot: min,
                maxSlot: max,
              }
            : {
                section: "program",
                laneIdx: start.laneIdx ?? 0,
                minSlot: min,
                maxSlot: max,
              },
        );
      }
    };

    const onUp = () => {
      const start = paintStartRef.current;
      paintStartRef.current = null;
      const current = paintOverlayRef.current;
      if (!start || current === null) return;
      const min = Math.min(current.minSlot, current.maxSlot);
      const max = Math.max(current.minSlot, current.maxSlot);
      setPaintOverlay(null);
      openPaintCreate(start.section, start.rowId, min, max);
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

  const handleDragEnd = (event: DragEndEvent) => {
    setDraggingId(null);
    const { active, over } = event;
    if (!over) return;

    const dragData = active.data.current as
      | MasterSessionDragData
      | MasterProgramBlockDragData
      | undefined;
    const dropData = over.data.current as MasterCellDropData | undefined;
    if (!dragData || dropData?.type !== "cell") return;

    const oldStart = new Date(dragData.startAt);
    const oldEnd = new Date(dragData.endAt);
    const durationMs = oldEnd.getTime() - oldStart.getTime();

    // CAGE session: drop target must be a resource cell (30-min). New start =
    // start of that 30-min slot; resource may change (the drop cell's row).
    if (dragData.type === "session" && dropData.section === "resource") {
      const newStart = slotStartAt(selectedDate, dropData.slotIndex);
      const newEnd = new Date(newStart.getTime() + durationMs);
      const oldResourceId = sessions.find((s) => s.id === dragData.id)
        ?.resourceId;
      // No-op when nothing moved (same slot AND same resource row).
      if (
        newStart.getTime() === oldStart.getTime() &&
        dropData.resourceId === oldResourceId
      ) {
        return;
      }
      startTransition(async () => {
        try {
          await updateSession(dragData.id, {
            resourceId: dropData.resourceId,
            startAt: newStart,
            endAt: newEnd,
          });
          setDragError(null);
          // The bars render purely from server props; without a refresh the
          // dnd-kit transform clears and the moved bar snaps back to its old
          // server-rendered spot until the 30s AutoRefresh poll. Re-pull now.
          router.refresh();
        } catch (err) {
          surfaceDragError(err);
        }
      });
      return;
    }

    // PROGRAM block: drop target must be a program cell. #8: the program drop
    // layer is now 30-min (dropData.slotIndex is a 0..27 30-min index), so
    // moves snap to 30-min — decode to the 15-min template via *2. New start =
    // start of that 30-min slot. Only the times are sent → the action leaves
    // program / coaches / occupied resources / note untouched (and auto-moves
    // any linked cage blocked_times to the new time).
    if (dragData.type === "program-block" && dropData.section === "program") {
      const newStart = slotStartAt15(selectedDate, dropData.slotIndex * 2);
      const newEnd = new Date(newStart.getTime() + durationMs);
      if (newStart.getTime() === oldStart.getTime()) return; // no-op
      startTransition(async () => {
        try {
          await updateProgramScheduleBlock(dragData.id, {
            startAt: newStart,
            endAt: newEnd,
          });
          setDragError(null);
          // Re-pull the server route so the moved bar re-renders in its new
          // position immediately (the transform clears on dragEnd; without a
          // refresh it snaps back until the 30s AutoRefresh poll).
          router.refresh();
        } catch (err) {
          surfaceDragError(err);
        }
      });
      return;
    }

    // Mismatched section (e.g. a cage bar dropped on a program cell): ignore;
    // the bar snaps back automatically when the dnd-kit transform clears.
  };

  // Friendly, auto-dismissing drag-error toast (snap-back is automatic — a
  // failed action doesn't revalidate, and the transform clears on dragEnd).
  const surfaceDragError = (err: unknown) => {
    const message =
      err instanceof Error && err.message
        ? err.message
        : "Couldn't move that. Try a different slot.";
    setDragError(message);
    setTimeout(() => setDragError(null), 6_000);
  };

  const handleEmptyCellClick: EmptyCellClick = ({
    section,
    rowId,
    slotIndex,
  }) => {
    // #8: BOTH the cage (resource) section AND the Work (program) section now
    // report 30-min slot indices for the clickable empty-cell layer. A single
    // empty-cell click defaults to a 30-min block (= one slot) in both
    // sections. The program section's bars still render at 15-min precision,
    // but its click/drop layer is 30-min (slotIndex 0..27, decoded to the
    // 15-min template via *2).
    if (section === "resource") {
      const startAt = slotStartAt(selectedDate, slotIndex);
      const endAt = slotStartAt(selectedDate, slotIndex + 1); // +30 min
      setDialog({
        kind: "cage",
        prefill: { resourceId: rowId, startAt, endAt },
      });
    } else {
      const startAt = slotStartAt15(selectedDate, slotIndex * 2);
      const endAt = slotStartAt15(selectedDate, slotIndex * 2 + 2); // +30 min
      setDialog({
        kind: "program",
        prefill: {
          programId: rowId,
          startTime: formatPfaTime(startAt),
          endTime: formatPfaTime(endAt),
        },
      });
    }
  };

  // QA10 W3.9: click an existing bar → open its edit dialog by id. The grid
  // only calls this for bars whose id is present in the matching map (the
  // maps are built from the same rows the grid renders), so a lookup miss is
  // defensive only.
  const handleBlockClick: BlockClick = ({ kind, id }) => {
    if (kind === "session") {
      setDialog({ kind: "edit-session", id });
    } else if (kind === "block") {
      setDialog({ kind: "edit-block", id });
    } else {
      setDialog({ kind: "edit-program", id });
    }
  };

  // On close, re-pull the server component so a just-created session / block /
  // program-block shows up on the Home grid. The dialogs' own actions already
  // revalidate their paths; router.refresh() re-renders this server route.
  const close = () => {
    setDialog({ kind: "closed" });
    router.refresh();
  };

  // Seed values for whichever edit dialog is currently open (null otherwise).
  const editSession =
    dialog.kind === "edit-session"
      ? (sessionEditById[dialog.id] ?? null)
      : null;
  const editBlock =
    dialog.kind === "edit-block" ? (blockEditById[dialog.id] ?? null) : null;
  const editProgram =
    dialog.kind === "edit-program"
      ? (programEditById[dialog.id] ?? null)
      : null;
  const editProgramSeries =
    editProgram && editProgram.seriesId
      ? (seriesById[editProgram.seriesId] ?? null)
      : null;
  const editProgramRecon = editProgram
    ? (reconciliation[editProgram.id] ?? null)
    : null;

  return (
    <>
      <p className="mb-2 text-xs text-fg-subtle">
        Click an empty slot to add, drag across empty slots to paint a time
        range, click a block to view/edit, or drag a block to move it.
      </p>

      {dragError ? (
        <div
          role="alert"
          className="mb-2 flex items-start justify-between gap-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
        >
          <span>{dragError}</span>
          <button
            type="button"
            onClick={() => setDragError(null)}
            className="text-[10px] uppercase tracking-wider text-danger/70 hover:text-danger"
          >
            Dismiss
          </button>
        </div>
      ) : null}

      <DndContext
        sensors={sensors}
        onDragStart={(e) => setDraggingId(bareDragId(String(e.active.id)))}
        onDragCancel={() => setDraggingId(null)}
        onDragEnd={handleDragEnd}
      >
        <MasterScheduleGrid
          resources={resources}
          sessions={sessions}
          blockedTimes={blockedTimes}
          programs={programs}
          programBlocks={programBlocks}
          onEmptyCellClick={handleEmptyCellClick}
          onBlockClick={handleBlockClick}
          dragEnabled
          draggingId={draggingId}
          onCellPaintPointerDown={handleCellPaintPointerDown}
          onCellClickWrapped={handleCellClickWrapped}
          registerGridNode={registerGridNode}
          paintOverlay={paintOverlay}
        />
      </DndContext>

      <ScheduleCreateDialog
        open={dialog.kind === "cage"}
        onClose={close}
        coaches={cageCoaches}
        resources={cageResources}
        prefill={dialog.kind === "cage" ? dialog.prefill : null}
        defaultTab="session"
      />

      <ProgramBlockDialog
        open={dialog.kind === "program"}
        mode="create"
        onClose={close}
        date={selectedDate}
        programs={programOptions}
        coaches={programCoaches}
        resources={programResources}
        createPrefill={dialog.kind === "program" ? dialog.prefill : null}
        editInitial={null}
        editSeriesInitial={null}
      />

      {/* QA10 W3.9: edit dialogs, reusing the EXACT standalone-schedule
          dialogs, seeded by id from the enriched maps. router.refresh() on
          close so edits/deletes reflect on the server-rendered Home grid. */}
      <SessionFormDialog
        open={dialog.kind === "edit-session" && editSession !== null}
        mode="edit"
        onClose={close}
        coachOptions={cageCoaches}
        resourceOptions={cageResources}
        initial={editSession ?? undefined}
      />

      <BlockEditDialog
        open={dialog.kind === "edit-block" && editBlock !== null}
        onClose={close}
        resources={cageResources}
        initial={editBlock ?? undefined}
      />

      <ProgramBlockDialog
        open={dialog.kind === "edit-program" && editProgram !== null}
        mode="edit"
        onClose={close}
        date={selectedDate}
        programs={programOptions}
        coaches={programCoaches}
        resources={programResources}
        createPrefill={null}
        editInitial={editProgram}
        editSeriesInitial={editProgramSeries}
        reconciliation={editProgramRecon}
      />
    </>
  );
}
