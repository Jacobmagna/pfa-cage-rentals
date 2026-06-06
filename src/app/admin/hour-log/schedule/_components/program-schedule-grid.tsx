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
// NO drag-to-create or drag-to-move (the admin sets precise start/end
// times in the dialog).

import { useState } from "react";
import { assignLanes } from "@/lib/schedule-lanes";
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
const SLOTS = (LAST_HOUR - FIRST_HOUR) * 2; // 28

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

// Maps a reconciliation status → the bar's left-accent + bg-tint classes
// and the tiny status-label text. `pending`/missing keep the neutral gold
// accent. All token colors are AA-safe per globals.css.
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
      return "border-l-gold bg-surface-2";
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

  const close = () => setDialog({ kind: "closed" });

  // QA10 W3.8a: empty-cell create no longer preselects a program — the admin
  // picks it in the dialog. Prefill carries only the clicked time.
  const openCreateAt = (slotIdx: number) => {
    const start = pfaWallClockAt(
      selectedDate,
      FIRST_HOUR + Math.floor(slotIdx / 2),
      (slotIdx % 2) * 30,
    );
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
  const occupiedSlots = new Set<number>();
  for (const b of visibleBlocks) {
    const placement = placeOnGrid(b.startAt, b.endAt);
    if (!placement) continue;
    for (let i = 0; i < placement.span; i++) {
      occupiedSlots.add(placement.col - 1 + i);
    }
  }

  const gridStyle: React.CSSProperties = {
    gridTemplateColumns: `repeat(${SLOTS}, minmax(36px, 1fr))`,
    gridTemplateRows: `40px repeat(${laneRows}, 56px)`,
  };

  return (
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

            {/* Cells — one per (lane row × slot), clickable when the slot's
                time is not covered by any block. Occupied cells skip the
                click so the bar above wins it. */}
            {Array.from({ length: laneRows }).map((_, laneIdx) =>
              Array.from({ length: SLOTS }).map((_, slotIdx) => {
                const isOccupied = occupiedSlots.has(slotIdx);
                const baseBorders =
                  slotIdx % 2 === 0
                    ? "border-l border-line-strong"
                    : "border-l border-line/40";
                return (
                  <button
                    key={`cell-${laneIdx}-${slotIdx}`}
                    type="button"
                    onClick={
                      isOccupied ? undefined : () => openCreateAt(slotIdx)
                    }
                    disabled={isOccupied}
                    tabIndex={isOccupied ? -1 : 0}
                    aria-label={
                      isOccupied
                        ? undefined
                        : `Schedule a program at ${formatHour(
                            FIRST_HOUR + Math.floor(slotIdx / 2),
                          )}${slotIdx % 2 === 1 ? ":30" : ""}`
                    }
                    className={[
                      "border-b border-line text-left",
                      baseBorders,
                      isOccupied
                        ? "cursor-default bg-surface-2/40"
                        : "bg-surface-2/40 transition-colors hover:bg-gold/5 focus-visible:outline-none focus-visible:bg-gold/10",
                    ].join(" ")}
                    style={{ gridRow: laneIdx + 2, gridColumn: slotIdx + 1 }}
                  />
                );
              }),
            )}

            {/* Block bars. QA10 W3.8a: row = the block's assigned lane + 2
                (header is row 1); primary label = the PROGRAM name. */}
            {visibleBlocks.map((b) => {
              const lane = laneByBlockId.get(b.id);
              if (lane === undefined) return null;
              const placement = placeOnGrid(b.startAt, b.endAt);
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
                <button
                  key={`block-${b.id}`}
                  type="button"
                  onClick={() => openEdit(b)}
                  className={[
                    "m-0.5 rounded-md border border-line px-2 py-1 text-[11px] text-fg shadow-[var(--shadow-sm)]",
                    "flex flex-col justify-center min-w-0 text-left border-l-4",
                    statusAccent(status),
                    "transition hover:shadow-[var(--shadow-md)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40",
                  ].join(" ")}
                  style={{
                    gridRow: lane + 2,
                    gridColumn: `${placement.col} / span ${placement.span}`,
                    zIndex: 2,
                  }}
                  title={`${tooltip} (click to edit)`}
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
            })}
          </div>
        </div>
      )}

      <div className="space-y-2 text-[11px] text-fg-muted">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <LegendDot className="bg-success" label="On schedule" />
          <LegendDot className="bg-danger" label="Wrong coach" />
          <LegendDot className="bg-danger" label="Wrong time" />
          <LegendDot className="bg-danger" label="No-show" />
          <LegendDot className="bg-gold" label="Pending" />
        </div>
        <p className="text-fg-subtle">
          Click an empty area to schedule a program block (pick the program in
          the dialog). Click a block to edit or delete it. Each bar shows the
          program, time, and reconciliation status (how the logged hours
          compare to the schedule); the scheduled coach(es) appear in the
          tooltip and the edit dialog.
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
  // No label column (QA10 W3.8a): slot 0 → grid column 1.
  return { col: clippedStart + 1, span: clippedEnd - clippedStart };
}

function formatHour(hour24: number): string {
  if (hour24 === 0) return "12 AM";
  if (hour24 === 12) return "12 PM";
  if (hour24 < 12) return `${hour24} AM`;
  return `${hour24 - 12} PM`;
}
