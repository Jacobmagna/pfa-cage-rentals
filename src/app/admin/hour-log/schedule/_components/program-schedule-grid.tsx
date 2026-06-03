"use client";

// Programs schedule grid for a single day (SCR-1a). Mirrors the cage
// schedule-grid's VISUAL layout — program rows × 30-min time-slot
// columns 8 AM – 10 PM, sticky first column, overflow-x-auto, blocks
// rendered as bars spanning their slots — but with the two simplified
// interactions only:
//   - Click an empty cell → create dialog seeded with that program +
//     the cell's start time (default end = start + 60 min).
//   - Click a block bar → edit dialog (edit + delete).
// NO drag-to-create or drag-to-move (the admin sets precise start/end
// times in the dialog).

import { useState } from "react";
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
} from "./program-block-dialog";

const FIRST_HOUR = 8;
const LAST_HOUR = 22;
const SLOTS = (LAST_HOUR - FIRST_HOUR) * 2; // 28

export type ProgramScheduleBlockView = {
  id: string;
  programId: string;
  scheduledCoachId: string;
  coachName: string;
  startAt: Date;
  endAt: Date;
  note: string | null;
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
  blocks,
  selectedDate,
  statuses,
}: {
  programs: ProgramOption[];
  coaches: CoachOption[];
  blocks: ProgramScheduleBlockView[];
  selectedDate: Date;
  statuses: Record<string, BlockReconciliation>;
}) {
  const [dialog, setDialog] = useState<DialogState>({ kind: "closed" });

  const close = () => setDialog({ kind: "closed" });

  const openCreateAt = (programId: string, slotIdx: number) => {
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
        programId,
        startTime: formatPfaTime(start),
        endTime: formatPfaTime(end),
      },
    });
  };

  const openEdit = (block: ProgramScheduleBlockView) => {
    setDialog({ kind: "edit", block });
  };

  const programRow = new Map<string, number>();
  programs.forEach((p, i) => programRow.set(p.id, i + 2));

  const inRange = (when: Date) =>
    pfaHour(when) >= FIRST_HOUR && pfaHour(when) < LAST_HOUR;
  const visibleBlocks = blocks.filter((b) => inRange(b.startAt));
  const hiddenCount = blocks.length - visibleBlocks.length;

  // Cells under a block get pointer-events disabled so the bar wins the
  // click. Build the occupied set keyed by `${programId}-${slotIdx}`.
  const occupiedSlots = new Set<string>();
  for (const b of visibleBlocks) {
    const placement = placeOnGrid(b.startAt, b.endAt);
    if (!placement) continue;
    for (let i = 0; i < placement.span; i++) {
      occupiedSlots.add(`${b.programId}-${placement.col - 2 + i}`);
    }
  }

  const gridStyle: React.CSSProperties = {
    gridTemplateColumns: `120px repeat(${SLOTS}, minmax(36px, 1fr))`,
    gridTemplateRows: `40px repeat(${programs.length}, 56px)`,
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

            {/* Program label cells (sticky first column). */}
            {programs.map((p, i) => (
              <div
                key={`label-${p.id}`}
                className="sticky left-0 z-10 border-r border-line bg-surface flex items-center gap-2.5 pl-2 pr-3 py-2 text-sm font-medium text-fg"
                style={{ gridRow: i + 2, gridColumn: 1 }}
              >
                <span
                  aria-hidden
                  className="h-6 w-0.5 rounded-full bg-gold"
                />
                <span className="truncate">{p.name}</span>
              </div>
            ))}

            {/* Cells — clickable when empty. */}
            {programs.map((p, i) =>
              Array.from({ length: SLOTS }).map((_, slotIdx) => {
                const isOccupied = occupiedSlots.has(`${p.id}-${slotIdx}`);
                const baseBorders =
                  slotIdx % 2 === 0
                    ? "border-l border-line-strong"
                    : "border-l border-line/40";
                return (
                  <button
                    key={`cell-${p.id}-${slotIdx}`}
                    type="button"
                    onClick={
                      isOccupied ? undefined : () => openCreateAt(p.id, slotIdx)
                    }
                    disabled={isOccupied}
                    tabIndex={isOccupied ? -1 : 0}
                    aria-label={
                      isOccupied
                        ? undefined
                        : `Create on ${p.name} at ${formatHour(
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
                    style={{ gridRow: i + 2, gridColumn: slotIdx + 2 }}
                  />
                );
              }),
            )}

            {/* Block bars. */}
            {visibleBlocks.map((b) => {
              const row = programRow.get(b.programId);
              if (!row) return null;
              const placement = placeOnGrid(b.startAt, b.endAt);
              if (!placement) return null;
              const recon = statuses[b.id];
              const status = recon?.status;
              const timeLabel = `${formatPfaTime(b.startAt)}–${formatPfaTime(
                b.endAt,
              )}`;
              const tooltip = [b.coachName, timeLabel, b.note, recon?.detail]
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
                    gridRow: row,
                    gridColumn: `${placement.col} / span ${placement.span}`,
                    zIndex: 2,
                  }}
                  title={`${tooltip} (click to edit)`}
                >
                  <span className="truncate font-medium">{b.coachName}</span>
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
          Click an empty cell to schedule a program block. Click a block to
          edit or delete it. The bar label shows the scheduled coach, time, and
          reconciliation status (how the logged hours compare to the schedule).
        </p>
      </div>

      <ProgramBlockDialog
        open={dialog.kind !== "closed"}
        mode={dialog.kind === "edit" ? "edit" : "create"}
        onClose={close}
        date={selectedDate}
        programs={programs}
        coaches={coaches}
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
                startAt: dialog.block.startAt,
                endAt: dialog.block.endAt,
                note: dialog.block.note,
              }
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
  return { col: clippedStart + 2, span: clippedEnd - clippedStart };
}

function formatHour(hour24: number): string {
  if (hour24 === 0) return "12 AM";
  if (hour24 === 12) return "12 PM";
  if (hour24 < 12) return `${hour24} AM`;
  return `${hour24 - 12} PM`;
}
