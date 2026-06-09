"use client";

// Excel-style schedule grid for a single day, with:
//   - Click empty cell → unified create dialog (Session/Block tabs)
//   - Click session → edit dialog
//   - Click block → confirm + delete
//   - Drag session block → updateSession with new (resource, startAt)
//     preserving duration. Touch-friendly via @dnd-kit's TouchSensor.
//
// Rows = resources, Columns = 30-min slots 8 AM – 10 PM. Sessions
// and blocks render via CSS Grid `grid-column: start / span N` so a
// multi-slot booking reads as one contiguous bar.
//
// Per-resource-type visual differentiation:
//   Cage = gold left-border, Bullpen = success, Weight = warning.
// Block body = neutral (bg-surface-2); status tokens are used as
// type MARKERS, not decoration — respects the spec's gold-only rule.

import { useEffect, useRef, useState, useTransition } from "react";
import { BlockEditDialog } from "./block-edit-dialog";
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
import type { ResourceType } from "@/lib/billing";
import { updateSession } from "@/app/admin/sessions/actions";
import { SessionFormDialog } from "@/app/admin/sessions/_components/session-form-dialog";
import type {
  CoachOption,
  ResourceOption as SessionResourceOption,
} from "@/app/admin/sessions/_components/sessions-client";
import {
  ScheduleCreateDialog,
  type CreatePrefill,
} from "./schedule-create-dialog";
import { pfaHour, pfaMinute, pfaWallClockAt } from "@/lib/timezone";

const FIRST_HOUR = 8;
const LAST_HOUR = 22;
const SLOTS = (LAST_HOUR - FIRST_HOUR) * 2; // 28

export type ScheduleResource = {
  id: string;
  name: string;
  type: ResourceType;
  sortOrder: number;
};

export type ScheduleSession = {
  id: string;
  coachId: string;
  coachName: string;
  resourceId: string;
  startAt: Date;
  endAt: Date;
  note: string | null;
};

export type ScheduleBlock = {
  id: string;
  resourceId: string;
  startAt: Date;
  endAt: Date;
  reason: string;
};

type DialogState =
  | { kind: "closed" }
  | {
      kind: "create";
      prefill: CreatePrefill;
      /** "block" when reached via paint-mode; defaults to "session". */
      defaultTab?: "session" | "block";
    }
  | { kind: "edit-session"; session: ScheduleSession }
  | { kind: "edit-block"; block: ScheduleBlock };

type PaintState =
  | { kind: "idle" }
  | {
      kind: "active";
      resourceId: string;
      // Inclusive endpoints. start can be > end while painting leftward;
      // commit normalizes to min..max.
      startSlot: number;
      endSlot: number;
    };

type CellDropData = {
  type: "cell";
  resourceId: string;
  slotIdx: number;
};

type SessionDragData = {
  type: "session";
  sessionId: string;
  startAt: string; // ISO; @dnd-kit serializes data, easier to pass strings
  endAt: string;
};

export function ScheduleGrid({
  resources,
  sessions,
  blocks,
  coaches,
  selectedDate,
}: {
  resources: ScheduleResource[];
  sessions: ScheduleSession[];
  blocks: ScheduleBlock[];
  coaches: CoachOption[];
  selectedDate: Date;
}) {
  const [dialog, setDialog] = useState<DialogState>({ kind: "closed" });
  const [dragError, setDragError] = useState<string | null>(null);
  const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null);
  const [paint, setPaint] = useState<PaintState>({ kind: "idle" });
  const [, startTransition] = useTransition();

  // Holds the pointerdown anchor between pointerdown and the first
  // pointermove that crosses the 5px activation threshold. Lives in a
  // ref because we don't want re-renders for every pointermove.
  const paintStartRef = useRef<{
    resourceId: string;
    slotIdx: number;
    x: number;
    y: number;
  } | null>(null);
  // Set when paint activated for the current pointer cycle, so the
  // cell's onClick (which fires AFTER pointerup) skips its single-cell
  // create. Cleared on the next click event.
  const suppressNextClickRef = useRef(false);

  // The grid DOM node — used by the paint pointermove handler to
  // convert clientX into a slot index via getBoundingClientRect.
  // elementFromPoint would be wrong here: sessions/blocks sit on top
  // of cells (higher z-index), so painting across them would lose
  // track of the underlying cell. Geometry math doesn't care.
  const gridRef = useRef<HTMLDivElement | null>(null);

  // distance: 5 lets short clicks through as clicks; only after the
  // pointer moves 5px does @dnd-kit activate a drag. Touch has a
  // small delay so scrolling on a touchscreen still works.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 5 },
    }),
  );

  const close = () => setDialog({ kind: "closed" });

  // Latest-ref pattern: window-level pointer handlers are bound once
  // but need the freshest props/state. The refs sync in a dedicated
  // post-commit effect (no deps) — assigning to ref.current during
  // render is flagged by react-hooks/refs in React 19 because it
  // makes the render impure. The handler closure may briefly see the
  // previous values between commit and effect, but pointer events
  // can't fire during that interval (the browser hands them out
  // synchronously between paints), so this is safe in practice.
  const paintRef = useRef(paint);
  const sessionsRef = useRef(sessions);
  const blocksRef = useRef(blocks);
  const selectedDateRef = useRef(selectedDate);
  useEffect(() => {
    paintRef.current = paint;
    sessionsRef.current = sessions;
    blocksRef.current = blocks;
    selectedDateRef.current = selectedDate;
  });

  const isCellOccupied = (resourceId: string, slotIdx: number) => {
    for (const s of sessionsRef.current) {
      if (s.resourceId !== resourceId) continue;
      const p = placeOnGrid(s.startAt, s.endAt);
      if (p && slotIdx >= p.col - 2 && slotIdx < p.col - 2 + p.span) return true;
    }
    for (const b of blocksRef.current) {
      if (b.resourceId !== resourceId) continue;
      const p = placeOnGrid(b.startAt, b.endAt);
      if (p && slotIdx >= p.col - 2 && slotIdx < p.col - 2 + p.span) return true;
    }
    return false;
  };

  // Convert pointer.clientX to a slot index by measuring the grid's
  // cell-area bounding rect. The grid template is "120px repeat(SLOTS,
  // minmax(36px, 1fr))" — first column is the resource label, then
  // SLOTS equal cells filling the rest of the row.
  const slotIndexFromClientX = (clientX: number): number | null => {
    const grid = gridRef.current;
    if (!grid) return null;
    const rect = grid.getBoundingClientRect();
    const cellsLeft = rect.left + 120;
    const cellsWidth = rect.right - cellsLeft;
    if (clientX < cellsLeft) return 0;
    if (clientX >= rect.right) return SLOTS - 1;
    const idx = Math.floor(((clientX - cellsLeft) / cellsWidth) * SLOTS);
    return Math.max(0, Math.min(SLOTS - 1, idx));
  };

  const handleCellPointerDown = (
    resourceId: string,
    slotIdx: number,
    e: React.PointerEvent<HTMLButtonElement>,
  ) => {
    if (e.button !== 0) return; // left click only
    // Clear any stale suppress flag from a previous gesture. If the
    // last paint committed but its trailing click never landed
    // (dialog took focus, pointer was elsewhere, etc.), the flag
    // could otherwise eat this gesture's click.
    suppressNextClickRef.current = false;
    paintStartRef.current = {
      resourceId,
      slotIdx,
      x: e.clientX,
      y: e.clientY,
    };
  };

  const handleCellClick = (onCreate: () => void) => {
    // Paint just committed in pointerup → swallow the trailing click
    // so we don't ALSO open the single-cell create dialog.
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }
    onCreate();
  };

  // Window-level pointer handlers for paint mode. Bound once on mount;
  // all dynamic data comes through refs (latest-ref pattern) so we
  // don't re-bind on every state change.
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
          resourceId: start.resourceId,
          startSlot: start.slotIdx,
          endSlot: start.slotIdx,
        });
        return;
      }

      // Already painting — update endSlot to where the pointer is now,
      // clamped at the first occupied cell between startSlot and the
      // pointer's slot.
      const targetSlot = slotIndexFromClientX(e.clientX);
      if (targetSlot === null) return;
      const dir = targetSlot >= current.startSlot ? 1 : -1;
      let clampedEnd = current.startSlot;
      for (
        let i = current.startSlot + dir;
        dir > 0 ? i <= targetSlot : i >= targetSlot;
        i += dir
      ) {
        if (isCellOccupied(current.resourceId, i)) break;
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
        const startAt = pfaWallClockAt(
          selectedDateRef.current,
          FIRST_HOUR + Math.floor(min / 2),
          (min % 2) * 30,
        );
        // max is inclusive; the block runs through the END of slot `max`.
        const endSlotBoundary = max + 1;
        const endAt = pfaWallClockAt(
          selectedDateRef.current,
          FIRST_HOUR + Math.floor(endSlotBoundary / 2),
          (endSlotBoundary % 2) * 30,
        );
        setDialog({
          kind: "create",
          prefill: { resourceId: current.resourceId, startAt, endAt },
          defaultTab: "block",
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
    // Bound once; everything dynamic flows through refs above.
  }, []);

  const openCreateAt = (resource: ScheduleResource, slotIdx: number) => {
    const startAt = pfaWallClockAt(
      selectedDate,
      FIRST_HOUR + Math.floor(slotIdx / 2),
      (slotIdx % 2) * 30,
    );
    const endAt = pfaWallClockAt(
      selectedDate,
      pfaHour(startAt) + 1,
      pfaMinute(startAt),
    );
    setDialog({
      kind: "create",
      prefill: { resourceId: resource.id, startAt, endAt },
    });
  };

  const openEditSession = (session: ScheduleSession) => {
    setDialog({ kind: "edit-session", session });
  };

  const openEditBlock = (block: ScheduleBlock) => {
    setDialog({ kind: "edit-block", block });
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setDraggingSessionId(null);
    const { active, over } = event;
    if (!over) return;

    const sessionData = active.data.current as SessionDragData | undefined;
    const dropData = over.data.current as CellDropData | undefined;
    if (sessionData?.type !== "session" || dropData?.type !== "cell") return;

    const oldStart = new Date(sessionData.startAt);
    const oldEnd = new Date(sessionData.endAt);
    const durationMs = oldEnd.getTime() - oldStart.getTime();

    const newStart = pfaWallClockAt(
      selectedDate,
      FIRST_HOUR + Math.floor(dropData.slotIdx / 2),
      (dropData.slotIdx % 2) * 30,
    );
    const newEnd = new Date(newStart.getTime() + durationMs);

    // No-op if dropped on the same cell.
    const oldResourceId = sessions.find((s) => s.id === sessionData.sessionId)
      ?.resourceId;
    if (
      newStart.getTime() === oldStart.getTime() &&
      dropData.resourceId === oldResourceId
    ) {
      return;
    }

    startTransition(async () => {
      try {
        await updateSession(sessionData.sessionId, {
          resourceId: dropData.resourceId,
          startAt: newStart,
          endAt: newEnd,
        });
        setDragError(null);
      } catch (err) {
        // SessionOverlapError / BlockedTimeError / others — surface
        // the friendly message; the visual snaps back automatically
        // because revalidatePath doesn't re-render on error and the
        // dnd-kit transform clears on dragEnd.
        const message =
          err instanceof Error && err.message
            ? err.message
            : "Couldn't move that session. Try a different slot.";
        setDragError(message);
        // Auto-dismiss after 6 seconds.
        setTimeout(() => setDragError(null), 6_000);
      }
    });
  };

  const resourceRow = new Map<string, number>();
  resources.forEach((r, i) => resourceRow.set(r.id, i + 2));

  const inRange = (when: Date) =>
    pfaHour(when) >= FIRST_HOUR && pfaHour(when) < LAST_HOUR;
  const visibleSessions = sessions.filter((s) => inRange(s.startAt));
  const hiddenCount = sessions.length - visibleSessions.length;
  const visibleBlocks = blocks.filter((b) => inRange(b.startAt));

  // Sessions/blocks claim multi-slot rectangles; the cells under them
  // get pointer-events disabled so the overlay's drop target wins.
  //
  // J4c: skip the actively-dragged session's own footprint when
  // building this set. Otherwise dragging a 10:00–11:00 session to
  // 10:30 fails because every cell inside the source rectangle is
  // marked "occupied by itself" and rejects the drop. The session
  // dragged out cleanly when the cursor crossed into a neighbor
  // resource row, but a half-slot shift within the same row was
  // impossible without dragging fully out + back.
  const occupiedSlots = new Set<string>();
  for (const s of visibleSessions) {
    if (s.id === draggingSessionId) continue;
    const placement = placeOnGrid(s.startAt, s.endAt);
    if (!placement) continue;
    for (let i = 0; i < placement.span; i++) {
      occupiedSlots.add(`${s.resourceId}-${placement.col - 2 + i}`);
    }
  }
  for (const b of visibleBlocks) {
    const placement = placeOnGrid(b.startAt, b.endAt);
    if (!placement) continue;
    for (let i = 0; i < placement.span; i++) {
      occupiedSlots.add(`${b.resourceId}-${placement.col - 2 + i}`);
    }
  }

  const gridStyle: React.CSSProperties = {
    gridTemplateColumns: `120px repeat(${SLOTS}, minmax(36px, 1fr))`,
    gridTemplateRows: `40px repeat(${resources.length}, 56px)`,
  };

  const editInitial =
    dialog.kind === "edit-session"
      ? {
          id: dialog.session.id,
          coachId: dialog.session.coachId,
          resourceId: dialog.session.resourceId,
          startAt: dialog.session.startAt,
          endAt: dialog.session.endAt,
          note: dialog.session.note,
        }
      : undefined;

  const sessionResourceOptions: SessionResourceOption[] = resources.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    sortOrder: r.sortOrder,
  }));

  return (
    <DndContext
      sensors={sensors}
      onDragStart={(e) => setDraggingSessionId(String(e.active.id))}
      onDragCancel={() => setDraggingSessionId(null)}
      onDragEnd={handleDragEnd}
    >
      <div className="space-y-3">
        {hiddenCount > 0 ? (
          <div
            role="status"
            className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning"
          >
            {hiddenCount} {hiddenCount === 1 ? "session is" : "sessions are"}{" "}
            outside the 8 AM – 10 PM range and not shown here.
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

        <div className="overflow-x-auto rounded-xl border border-line shadow-[var(--shadow-sm)]">
          <div
            ref={gridRef}
            className="relative grid bg-surface min-w-fit"
            style={gridStyle}
          >
            {/* Header corner cell. */}
            <div
              className="sticky left-0 z-20 border-b border-r border-line bg-surface"
              style={{ gridRow: 1, gridColumn: 1 }}
            />

            {/* Time-slot headers. */}
            {Array.from({ length: SLOTS }).map((_, slotIdx) => {
              const col = slotIdx + 2;
              const isHour = slotIdx % 2 === 0;
              const hour24 = FIRST_HOUR + Math.floor(slotIdx / 2);
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
                  {isHour ? formatHour(hour24) : ""}
                </div>
              );
            })}

            {/* Resource label cells. A type-colored stripe on the left
                lets the eye correlate row → resource type → session
                accent border without reading the legend. */}
            {resources.map((r, i) => (
              <div
                key={`label-${r.id}`}
                className="sticky left-0 z-10 border-r border-line bg-surface flex items-center gap-2.5 pl-2 pr-3 py-2 text-sm font-medium text-fg"
                style={{ gridRow: i + 2, gridColumn: 1 }}
              >
                <span
                  aria-hidden
                  className={`h-6 w-0.5 rounded-full ${typeStripe(r.type)}`}
                />
                <span className="truncate">{r.name}</span>
              </div>
            ))}

            {/* Cells — droppable + clickable when empty + paint-aware. */}
            {resources.map((r, i) =>
              Array.from({ length: SLOTS }).map((_, slotIdx) => (
                <DroppableCell
                  key={`cell-${r.id}-${slotIdx}`}
                  resource={r}
                  slotIdx={slotIdx}
                  row={i + 2}
                  isOccupied={occupiedSlots.has(`${r.id}-${slotIdx}`)}
                  isDraggingSession={draggingSessionId !== null}
                  onCreate={() => openCreateAt(r, slotIdx)}
                  onPointerDown={handleCellPointerDown}
                  onClickWrapped={handleCellClick}
                />
              )),
            )}

            {/* Paint highlight — a gold dashed overlay across the painted range. */}
            {paint.kind === "active"
              ? (() => {
                  const row = resourceRow.get(paint.resourceId);
                  if (!row) return null;
                  const min = Math.min(paint.startSlot, paint.endSlot);
                  const max = Math.max(paint.startSlot, paint.endSlot);
                  return (
                    <div
                      aria-hidden
                      style={{
                        gridRow: row,
                        gridColumn: `${min + 2} / span ${max - min + 1}`,
                        pointerEvents: "none",
                        zIndex: 5,
                      }}
                      className="m-0.5 rounded border-2 border-dashed border-gold/80 bg-gold/15"
                    />
                  );
                })()
              : null}

            {/* Blocks. */}
            {visibleBlocks.map((b) => {
              const row = resourceRow.get(b.resourceId);
              if (!row) return null;
              const placement = placeOnGrid(b.startAt, b.endAt);
              if (!placement) return null;
              return (
                <button
                  key={`block-${b.id}`}
                  type="button"
                  onClick={() => openEditBlock(b)}
                  className={[
                    "m-0.5 rounded-md border border-dashed border-danger/60 bg-danger/10 px-2 py-1 text-[11px] text-danger shadow-[var(--shadow-sm)]",
                    "flex items-center min-w-0 text-left",
                    "transition hover:bg-danger/15 hover:shadow-[var(--shadow-md)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40",
                  ].join(" ")}
                  style={{
                    gridRow: row,
                    gridColumn: `${placement.col} / span ${placement.span}`,
                    zIndex: 1,
                  }}
                  title={`Blocked: ${b.reason} (click to edit)`}
                >
                  <span className="truncate font-medium">{b.reason}</span>
                </button>
              );
            })}

            {/* Sessions — draggable + clickable for edit. */}
            {visibleSessions.map((s) => {
              const row = resourceRow.get(s.resourceId);
              if (!row) return null;
              const placement = placeOnGrid(s.startAt, s.endAt);
              if (!placement) return null;
              const resource = resources.find((r) => r.id === s.resourceId);
              return (
                <DraggableSession
                  key={`s-${s.id}`}
                  session={s}
                  resource={resource ?? null}
                  row={row}
                  placement={placement}
                  onEdit={() => openEditSession(s)}
                />
              );
            })}
          </div>
        </div>

        <div className="space-y-2 text-[11px] text-fg-muted">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <LegendDot className="border-l-4 border-l-gold" label="Cage" />
            <LegendDot className="border-l-4 border-l-success" label="Bullpen" />
            <LegendDot className="border-l-4 border-l-warning" label="Weight Room" />
            <LegendDot
              className="border border-dashed border-danger/60 bg-danger/10"
              label="Blocked"
            />
          </div>
          <p className="text-fg-subtle">
            Click an empty cell to create. Drag across empty cells to block
            a range. Click a session or block to edit. Drag a session to
            move it.
          </p>
        </div>

        <ScheduleCreateDialog
          open={dialog.kind === "create"}
          onClose={close}
          coaches={coaches}
          resources={sessionResourceOptions}
          prefill={dialog.kind === "create" ? dialog.prefill : null}
          defaultTab={
            dialog.kind === "create" ? dialog.defaultTab ?? "session" : "session"
          }
        />

        <SessionFormDialog
          open={dialog.kind === "edit-session"}
          mode="edit"
          onClose={close}
          coachOptions={coaches}
          resourceOptions={sessionResourceOptions}
          initial={editInitial}
        />

        <BlockEditDialog
          open={dialog.kind === "edit-block"}
          onClose={close}
          resources={sessionResourceOptions}
          initial={
            dialog.kind === "edit-block"
              ? {
                  id: dialog.block.id,
                  resourceId: dialog.block.resourceId,
                  startAt: dialog.block.startAt,
                  endAt: dialog.block.endAt,
                  reason: dialog.block.reason,
                }
              : undefined
          }
        />
      </div>
    </DndContext>
  );
}

function DroppableCell({
  resource,
  slotIdx,
  row,
  isOccupied,
  isDraggingSession,
  onCreate,
  onPointerDown,
  onClickWrapped,
}: {
  resource: ScheduleResource;
  slotIdx: number;
  row: number;
  isOccupied: boolean;
  isDraggingSession: boolean;
  onCreate: () => void;
  onPointerDown: (
    resourceId: string,
    slotIdx: number,
    e: React.PointerEvent<HTMLButtonElement>,
  ) => void;
  onClickWrapped: (onCreate: () => void) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `drop-${resource.id}-${slotIdx}`,
    data: { type: "cell", resourceId: resource.id, slotIdx } as CellDropData,
    disabled: isOccupied,
  });

  // While a drag is in progress, ALL cells should look like neutral
  // drop targets — the click-to-create hover affordance would be
  // confusing mid-drag.
  const baseBorders =
    slotIdx % 2 === 0
      ? "border-l border-line-strong"
      : "border-l border-line/40";

  return (
    <button
      ref={setNodeRef}
      type="button"
      onClick={isOccupied ? undefined : () => onClickWrapped(onCreate)}
      onPointerDown={
        isOccupied ? undefined : (e) => onPointerDown(resource.id, slotIdx, e)
      }
      disabled={isOccupied}
      tabIndex={isOccupied ? -1 : 0}
      aria-label={
        isOccupied
          ? undefined
          : `Create on ${resource.name} at ${formatHour(FIRST_HOUR + Math.floor(slotIdx / 2))}${
              slotIdx % 2 === 1 ? ":30" : ""
            }`
      }
      className={[
        "border-b border-line text-left",
        baseBorders,
        isOccupied
          ? "cursor-default bg-surface-2/40"
          : isDraggingSession
            ? isOver
              ? "bg-gold/20"
              : "bg-page/40"
            : "bg-surface-2/40 transition-colors hover:bg-gold/5 focus-visible:outline-none focus-visible:bg-gold/10",
      ].join(" ")}
      style={{ gridRow: row, gridColumn: slotIdx + 2 }}
    />
  );
}

function DraggableSession({
  session,
  resource,
  row,
  placement,
  onEdit,
}: {
  session: ScheduleSession;
  resource: ScheduleResource | null;
  row: number;
  placement: { col: number; span: number };
  onEdit: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({
      id: session.id,
      data: {
        type: "session",
        sessionId: session.id,
        startAt: session.startAt.toISOString(),
        endAt: session.endAt.toISOString(),
      } as SessionDragData,
    });

  const accent = resource ? typeBorder(resource.type) : "";
  const tooltip = [session.coachName, session.note]
    .filter(Boolean)
    .join(" · ");

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
        "m-0.5 rounded-md border border-line bg-surface-2 px-2 py-1 text-[11px] text-fg shadow-[var(--shadow-sm)]",
        "flex items-center gap-1.5 min-w-0 text-left",
        "transition hover:bg-surface hover:shadow-[var(--shadow-md)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40",
        accent,
        isDragging ? "opacity-40 cursor-grabbing" : "cursor-grab",
      ].join(" ")}
      style={{
        gridRow: row,
        gridColumn: `${placement.col} / span ${placement.span}`,
        zIndex: isDragging ? 30 : 2,
        ...dragTransform,
      }}
      title={tooltip}
    >
      <span className="truncate font-medium">{session.coachName}</span>
    </button>
  );
}

function placeOnGrid(
  startAt: Date,
  endAt: Date,
): { col: number; span: number } | null {
  const startSlots =
    (pfaHour(startAt) - FIRST_HOUR) * 2 + Math.floor(pfaMinute(startAt) / 30);
  const endSlots =
    (pfaHour(endAt) - FIRST_HOUR) * 2 + Math.ceil(pfaMinute(endAt) / 30);
  const clippedStart = Math.max(startSlots, 0);
  const clippedEnd = Math.min(endSlots, SLOTS);
  if (clippedEnd <= clippedStart) return null;
  return { col: clippedStart + 2, span: clippedEnd - clippedStart };
}

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

// Solid background variant of typeBorder for the resource-row label
// stripe. Same color semantics — cage gold, bullpen green, weight
// room amber — but as a fill since the stripe is its own element.
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

function formatHour(hour24: number): string {
  if (hour24 === 0) return "12 AM";
  if (hour24 === 12) return "12 PM";
  if (hour24 < 12) return `${hour24} AM`;
  return `${hour24 - 12} PM`;
}

function LegendDot({
  className,
  label,
}: {
  className: string;
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className={`inline-block h-3 w-5 rounded bg-surface-2 ${className}`} />
      {label}
    </span>
  );
}
