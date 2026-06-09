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

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  MasterScheduleGrid,
  type BlockClick,
  type EmptyCellClick,
  type MasterBlockedTime,
  type MasterProgramBlock,
  type MasterProgramRow,
  type MasterResourceRow,
  type MasterSession,
} from "./master-schedule-grid";
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
        Click an empty slot to add, or a block to view/edit.
      </p>

      <MasterScheduleGrid
        resources={resources}
        sessions={sessions}
        blockedTimes={blockedTimes}
        programs={programs}
        programBlocks={programBlocks}
        onEmptyCellClick={handleEmptyCellClick}
        onBlockClick={handleBlockClick}
      />

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
