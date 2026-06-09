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

import { useState, useTransition } from "react";
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
import { slotStartAt, slotStartAt15 } from "@/lib/schedule-grid-utils";
import { formatPfaTime, pfaHour, pfaMinute, pfaWallClockAt } from "@/lib/timezone";

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
        } catch (err) {
          surfaceDragError(err);
        }
      });
      return;
    }

    // PROGRAM block: drop target must be a program cell (15-min). New start =
    // start of that 15-min slot. Only the times are sent → the action leaves
    // program / coaches / occupied resources / note untouched (and auto-moves
    // any linked cage blocked_times to the new time).
    if (dragData.type === "program-block" && dropData.section === "program") {
      const newStart = slotStartAt15(selectedDate, dropData.slotIndex);
      const newEnd = new Date(newStart.getTime() + durationMs);
      if (newStart.getTime() === oldStart.getTime()) return; // no-op
      startTransition(async () => {
        try {
          await updateProgramScheduleBlock(dragData.id, {
            startAt: newStart,
            endAt: newEnd,
          });
          setDragError(null);
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
    // #8: the cage (resource) section reports 30-min slot indices; the Work
    // (program) section reports 15-min slot indices. Decode with the matching
    // helper so the clicked cell maps to the right start time.
    const start =
      section === "resource"
        ? slotStartAt(selectedDate, slotIndex)
        : slotStartAt15(selectedDate, slotIndex);
    // Default span = 60 min, mirroring the standalone grids' openCreateAt.
    const end = pfaWallClockAt(
      selectedDate,
      pfaHour(start) + 1,
      pfaMinute(start),
    );
    if (section === "resource") {
      setDialog({
        kind: "cage",
        prefill: { resourceId: rowId, startAt: start, endAt: end },
      });
    } else {
      setDialog({
        kind: "program",
        prefill: {
          programId: rowId,
          startTime: formatPfaTime(start),
          endTime: formatPfaTime(end),
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
        Click an empty slot to add, a block to view/edit, or drag a block to
        move it.
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
