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
  ProgramBlockDialog,
  type CoachOption as ProgramCoachOption,
  type ProgramOption,
  type ResourceOption as ProgramResourceOption,
} from "@/app/admin/hour-log/schedule/_components/program-block-dialog";
import { slotStartAt } from "@/lib/schedule-grid-utils";
import { formatPfaTime, pfaHour, pfaMinute, pfaWallClockAt } from "@/lib/timezone";

type ProgramCreatePrefill = {
  programId: string;
  startTime: string;
  endTime: string;
};

type DialogState =
  | { kind: "closed" }
  | { kind: "cage"; prefill: CreatePrefill }
  | { kind: "program"; prefill: ProgramCreatePrefill };

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
}): React.JSX.Element {
  const router = useRouter();
  const [dialog, setDialog] = useState<DialogState>({ kind: "closed" });

  const handleEmptyCellClick: EmptyCellClick = ({
    section,
    rowId,
    slotIndex,
  }) => {
    const start = slotStartAt(selectedDate, slotIndex);
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

  // On close, re-pull the server component so a just-created session / block /
  // program-block shows up on the Home grid. The dialogs' own actions already
  // revalidate their paths; router.refresh() re-renders this server route.
  const close = () => {
    setDialog({ kind: "closed" });
    router.refresh();
  };

  return (
    <>
      <p className="mb-2 text-xs text-fg-subtle">
        Click an empty slot to add a cage rental or program block.
      </p>

      <MasterScheduleGrid
        resources={resources}
        sessions={sessions}
        blockedTimes={blockedTimes}
        programs={programs}
        programBlocks={programBlocks}
        onEmptyCellClick={handleEmptyCellClick}
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
    </>
  );
}
