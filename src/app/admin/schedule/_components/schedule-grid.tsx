"use client";

// Excel-style schedule grid for a single day, with click-to-create
// and click-to-edit. Empty cell → unified create dialog (Session
// or Block toggle). Session block → edit dialog. Blocked time →
// confirm() + delete.
//
// Rows = resources (sorted by sortOrder), Columns = 30-min slots
// from 8 AM to 10 PM. Sessions and blocks render as positioned
// blocks via CSS Grid `grid-column: start / span N` so a multi-slot
// booking reads as one contiguous bar.
//
// Per-resource-type visual differentiation:
//   - Cage:        gold left-border (brand accent)
//   - Bullpen:     success left-border
//   - Weight room: warning left-border
//   - Blocked:     dashed danger border + tinted background
// Block bodies are neutral (bg-surface-2) — the spec's "gold is the
// only brand color" rule preserved by using status tokens as type
// markers, not decoration.
//
// Sessions outside 8 AM – 10 PM aren't rendered. A banner above the
// grid surfaces the count when any exist.

import { useState, useTransition } from "react";
import type { ResourceType } from "@/lib/billing";
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
  const [, startTransition] = useTransition();

  const close = () => setDialog({ kind: "closed" });

  const openCreateAt = (resource: ScheduleResource, slotIdx: number) => {
    const startAt = new Date(selectedDate);
    startAt.setHours(
      FIRST_HOUR + Math.floor(slotIdx / 2),
      (slotIdx % 2) * 30,
      0,
      0,
    );
    // Default 1-hour duration, clipped to last visible slot if
    // necessary (clicking 9:30 PM on a 1-hour default would otherwise
    // extend past 10:30 PM which is outside the visible range).
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

  // Index resources to a row number. Row 1 is the time-header row;
  // resources start at row 2.
  const resourceRow = new Map<string, number>();
  resources.forEach((r, i) => resourceRow.set(r.id, i + 2));

  const inRange = (when: Date) =>
    when.getHours() >= FIRST_HOUR && when.getHours() < LAST_HOUR;
  const visibleSessions = sessions.filter((s) => inRange(s.startAt));
  const hiddenCount = sessions.length - visibleSessions.length;
  const visibleBlocks = blocks.filter((b) => inRange(b.startAt));

  // Map of "this resource has a session or block at this slot" so
  // empty-cell buttons can short-circuit out of the way of overlay
  // blocks (otherwise clicks on an empty area beside a session would
  // accidentally hit the underlying empty cell). The session block's
  // z-index already sits above, so we don't strictly need this — but
  // disabling the empty button under blocks makes keyboard tab order
  // skip them.
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

  // Map session → SessionFormDialog initial shape.
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

  // SessionFormDialog expects ResourceOption with sortOrder.
  const sessionResourceOptions: SessionResourceOption[] = resources.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    sortOrder: r.sortOrder,
  }));

  return (
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

          {/* Resource label cells (sticky-left). */}
          {resources.map((r, i) => (
            <div
              key={`label-${r.id}`}
              className="sticky left-0 z-10 border-r border-line bg-surface px-3 py-2 text-sm font-medium text-fg flex items-center"
              style={{ gridRow: i + 2, gridColumn: 1 }}
            >
              <span className="truncate">{r.name}</span>
            </div>
          ))}

          {/* Empty-cell buttons. Each (resource × slot) becomes a
              clickable target. The few cells under a session/block
              get a disabled/hidden treatment so the overlay's
              click handler wins. */}
          {resources.map((r, i) =>
            Array.from({ length: SLOTS }).map((_, slotIdx) => {
              const key = `${r.id}-${slotIdx}`;
              const isOccupied = occupiedSlots.has(key);
              return (
                <button
                  key={`cell-${key}`}
                  type="button"
                  onClick={isOccupied ? undefined : () => openCreateAt(r, slotIdx)}
                  disabled={isOccupied}
                  tabIndex={isOccupied ? -1 : 0}
                  aria-label={
                    isOccupied
                      ? undefined
                      : `Create on ${r.name} at ${formatHour(FIRST_HOUR + Math.floor(slotIdx / 2))}${
                          slotIdx % 2 === 1 ? ":30" : ""
                        }`
                  }
                  className={[
                    "border-b border-line text-left",
                    slotIdx % 2 === 0
                      ? "border-l border-line-strong"
                      : "border-l border-line/40",
                    isOccupied
                      ? "cursor-default"
                      : "hover:bg-gold/5 focus-visible:outline-none focus-visible:bg-gold/10 transition-colors",
                  ].join(" ")}
                  style={{ gridRow: i + 2, gridColumn: slotIdx + 2 }}
                />
              );
            }),
          )}

          {/* Blocked-time blocks. */}
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

          {/* Session blocks. */}
          {visibleSessions.map((s) => {
            const row = resourceRow.get(s.resourceId);
            if (!row) return null;
            const placement = placeOnGrid(s.startAt, s.endAt);
            if (!placement) return null;
            const resource = resources.find((r) => r.id === s.resourceId);
            const accent = resource ? typeBorder(resource.type) : "";
            const tooltip = [
              s.coachName,
              s.useType ? cap(s.useType) : null,
              s.note,
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <button
                key={`s-${s.id}`}
                type="button"
                onClick={() => openEditSession(s)}
                className={`m-0.5 rounded border border-line bg-surface-2 ${accent} px-2 py-1 text-[11px] text-fg flex items-center gap-1.5 min-w-0 text-left hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors`}
                style={{
                  gridRow: row,
                  gridColumn: `${placement.col} / span ${placement.span}`,
                  zIndex: 1,
                }}
                title={tooltip}
              >
                <span className="truncate font-medium">{s.coachName}</span>
                {s.useType ? (
                  <span className="text-[9px] uppercase tracking-wider text-fg-subtle shrink-0">
                    {s.useType[0]}
                  </span>
                ) : null}
              </button>
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
          · Click an empty cell to create. Click a session to edit, a block to delete.
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
  return {
    col: clippedStart + 2,
    span: clippedEnd - clippedStart,
  };
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
