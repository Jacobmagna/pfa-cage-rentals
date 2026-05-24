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
import type { ResourceType } from "@/lib/billing";
import { updateSession } from "@/app/admin/sessions/actions";
import { SessionFormDialog } from "@/app/admin/sessions/_components/session-form-dialog";
import type {
  CoachOption,
  ResourceOption as SessionResourceOption,
} from "@/app/admin/sessions/_components/sessions-client";
import { deleteBlockAction } from "../form-actions";
import {
  ScheduleCreateDialog,
  type CreatePrefill,
} from "./schedule-create-dialog";

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
  useType: "hitting" | "pitching" | null;
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
  | { kind: "create"; prefill: CreatePrefill }
  | { kind: "edit-session"; session: ScheduleSession };

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
  const [pendingDeleteBlockId, setPendingDeleteBlockId] = useState<string | null>(
    null,
  );
  const [dragError, setDragError] = useState<string | null>(null);
  const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

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

  const openCreateAt = (resource: ScheduleResource, slotIdx: number) => {
    const startAt = new Date(selectedDate);
    startAt.setHours(
      FIRST_HOUR + Math.floor(slotIdx / 2),
      (slotIdx % 2) * 30,
      0,
      0,
    );
    const endAt = new Date(startAt);
    endAt.setHours(startAt.getHours() + 1);
    setDialog({
      kind: "create",
      prefill: { resourceId: resource.id, startAt, endAt },
    });
  };

  const openEditSession = (session: ScheduleSession) => {
    setDialog({ kind: "edit-session", session });
  };

  const handleDeleteBlock = (block: ScheduleBlock) => {
    if (
      !confirm(
        `Delete block "${block.reason}" on this resource?\nThis can't be undone.`,
      )
    ) {
      return;
    }
    setPendingDeleteBlockId(block.id);
    startTransition(async () => {
      try {
        await deleteBlockAction(block.id);
      } finally {
        setPendingDeleteBlockId(null);
      }
    });
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

    const newStart = new Date(selectedDate);
    newStart.setHours(
      FIRST_HOUR + Math.floor(dropData.slotIdx / 2),
      (dropData.slotIdx % 2) * 30,
      0,
      0,
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
    when.getHours() >= FIRST_HOUR && when.getHours() < LAST_HOUR;
  const visibleSessions = sessions.filter((s) => inRange(s.startAt));
  const hiddenCount = sessions.length - visibleSessions.length;
  const visibleBlocks = blocks.filter((b) => inRange(b.startAt));

  // Sessions/blocks claim multi-slot rectangles; the cells under them
  // get pointer-events disabled so the overlay's drop target wins.
  const occupiedSlots = new Set<string>();
  for (const s of visibleSessions) {
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
          useType: dialog.session.useType,
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

        <div className="overflow-x-auto rounded-lg border border-line">
          <div className="relative grid bg-surface min-w-fit" style={gridStyle}>
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

            {/* Resource label cells. */}
            {resources.map((r, i) => (
              <div
                key={`label-${r.id}`}
                className="sticky left-0 z-10 border-r border-line bg-surface px-3 py-2 text-sm font-medium text-fg flex items-center"
                style={{ gridRow: i + 2, gridColumn: 1 }}
              >
                <span className="truncate">{r.name}</span>
              </div>
            ))}

            {/* Cells — droppable + clickable when empty. */}
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
                />
              )),
            )}

            {/* Blocks. */}
            {visibleBlocks.map((b) => {
              const row = resourceRow.get(b.resourceId);
              if (!row) return null;
              const placement = placeOnGrid(b.startAt, b.endAt);
              if (!placement) return null;
              const isPending = pendingDeleteBlockId === b.id;
              return (
                <button
                  key={`block-${b.id}`}
                  type="button"
                  onClick={() => handleDeleteBlock(b)}
                  disabled={isPending}
                  className={[
                    "m-0.5 rounded border border-dashed border-danger/60 bg-danger/10 px-2 py-1 text-[11px] text-danger",
                    "flex items-center min-w-0 text-left",
                    "hover:bg-danger/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 transition-colors",
                    isPending ? "opacity-50" : "",
                  ].join(" ")}
                  style={{
                    gridRow: row,
                    gridColumn: `${placement.col} / span ${placement.span}`,
                    zIndex: 1,
                  }}
                  title={`Blocked: ${b.reason} (click to delete)`}
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

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px] text-fg-muted">
          <LegendDot className="border-l-4 border-l-gold" label="Cage" />
          <LegendDot className="border-l-4 border-l-success" label="Bullpen" />
          <LegendDot className="border-l-4 border-l-warning" label="Weight Room" />
          <LegendDot
            className="border border-dashed border-danger/60 bg-danger/10"
            label="Blocked"
          />
          <span className="text-fg-subtle">
            · Click empty cell to create. Click session to edit, block to
            delete. Drag a session to move it.
          </span>
        </div>

        <ScheduleCreateDialog
          open={dialog.kind === "create"}
          onClose={close}
          coaches={coaches}
          resources={sessionResourceOptions}
          prefill={dialog.kind === "create" ? dialog.prefill : null}
        />

        <SessionFormDialog
          open={dialog.kind === "edit-session"}
          mode="edit"
          onClose={close}
          coachOptions={coaches}
          resourceOptions={sessionResourceOptions}
          initial={editInitial}
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
}: {
  resource: ScheduleResource;
  slotIdx: number;
  row: number;
  isOccupied: boolean;
  isDraggingSession: boolean;
  onCreate: () => void;
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
      onClick={isOccupied ? undefined : onCreate}
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
          ? "cursor-default"
          : isDraggingSession
            ? isOver
              ? "bg-gold/20"
              : "bg-page/40"
            : "hover:bg-gold/5 focus-visible:outline-none focus-visible:bg-gold/10 transition-colors",
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
  const tooltip = [
    session.coachName,
    session.useType ? cap(session.useType) : null,
    session.note,
  ]
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
        "m-0.5 rounded border border-line bg-surface-2 px-2 py-1 text-[11px] text-fg",
        "flex items-center gap-1.5 min-w-0 text-left",
        "hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors",
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
      {session.useType ? (
        <span className="text-[9px] uppercase tracking-wider text-fg-subtle shrink-0">
          {session.useType[0]}
        </span>
      ) : null}
    </button>
  );
}

function placeOnGrid(
  startAt: Date,
  endAt: Date,
): { col: number; span: number } | null {
  const startSlots =
    (startAt.getHours() - FIRST_HOUR) * 2 + Math.floor(startAt.getMinutes() / 30);
  const endSlots =
    (endAt.getHours() - FIRST_HOUR) * 2 + Math.ceil(endAt.getMinutes() / 30);
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

function formatHour(hour24: number): string {
  if (hour24 === 0) return "12 AM";
  if (hour24 === 12) return "12 PM";
  if (hour24 < 12) return `${hour24} AM`;
  return `${hour24 - 12} PM`;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
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
