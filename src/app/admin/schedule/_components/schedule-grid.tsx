// Excel-style schedule grid for a single day.
// Rows = resources (sorted by sortOrder), Columns = 30-min slots from
// 8 AM to 10 PM. Sessions and blocked times render as positioned
// blocks via CSS Grid `grid-column: start / span N`, so a multi-slot
// session reads as one contiguous bar — not three split cells.
//
// Per-resource-type visual differentiation:
//   - Cage:        gold left-border (brand accent)
//   - Bullpen:     emerald left-border (--color-success token)
//   - Weight room: amber left-border (--color-warning token)
//   - Blocked:     red dashed border + tinted background (--color-danger)
// Block body stays neutral (bg-surface-2) — this respects the spec's
// "gold is the only brand color, status tokens are status" rule by
// using the status tokens as type markers, not decoration.
//
// Sessions outside 8 AM – 10 PM aren't rendered on the grid. A small
// banner above the grid surfaces the count when any exist.

import type { ResourceType } from "@/lib/billing";

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

export function ScheduleGrid({
  resources,
  sessions,
  blocks,
}: {
  resources: ScheduleResource[];
  sessions: ScheduleSession[];
  blocks: ScheduleBlock[];
}) {
  // Index resources to a row number. Row 1 is the time-header row;
  // resources start at row 2.
  const resourceRow = new Map<string, number>();
  resources.forEach((r, i) => resourceRow.set(r.id, i + 2));

  const inRange = (when: Date) =>
    when.getHours() >= FIRST_HOUR && when.getHours() < LAST_HOUR;
  const visibleSessions = sessions.filter((s) => inRange(s.startAt));
  const hiddenCount = sessions.length - visibleSessions.length;
  const visibleBlocks = blocks.filter((b) => inRange(b.startAt));

  // Grid template: 1 sticky label column + 28 slot columns, each at
  // minmax(34px, 1fr) so the layout responds to viewport width but
  // never collapses below tap-target width.
  const gridStyle: React.CSSProperties = {
    gridTemplateColumns: `120px repeat(${SLOTS}, minmax(36px, 1fr))`,
    gridTemplateRows: `40px repeat(${resources.length}, 56px)`,
  };

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
        <div
          className="relative grid bg-surface min-w-fit"
          style={gridStyle}
        >
          {/* Header corner cell. */}
          <div
            className="sticky left-0 z-20 border-b border-r border-line bg-surface"
            style={{ gridRow: 1, gridColumn: 1 }}
          />

          {/* Time-slot headers. Show hour labels at even slot indices
              (full hours); half-hour columns just get a faint tick via
              the border. */}
          {Array.from({ length: SLOTS }).map((_, slotIdx) => {
            const col = slotIdx + 2; // +1 for label col, +1 for 1-based
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

          {/* Background grid cells — one per (resource × slot) to
              draw vertical / horizontal lines. Layered under sessions
              + blocks. */}
          {resources.map((r, i) =>
            Array.from({ length: SLOTS }).map((_, slotIdx) => (
              <div
                key={`cell-${r.id}-${slotIdx}`}
                className={[
                  "border-b border-line",
                  slotIdx % 2 === 0
                    ? "border-l border-line-strong"
                    : "border-l border-line/40",
                ].join(" ")}
                style={{ gridRow: i + 2, gridColumn: slotIdx + 2 }}
              />
            )),
          )}

          {/* Blocked-time blocks render under sessions but over the
              background cells — DOM order matters when grid items
              share cells, so emit blocks first. */}
          {visibleBlocks.map((b) => {
            const row = resourceRow.get(b.resourceId);
            if (!row) return null;
            const placement = placeOnGrid(b.startAt, b.endAt);
            if (!placement) return null;
            return (
              <div
                key={`block-${b.id}`}
                className="m-0.5 rounded border border-dashed border-danger/60 bg-danger/10 px-2 py-1 text-[11px] text-danger flex items-center min-w-0"
                style={{
                  gridRow: row,
                  gridColumn: `${placement.col} / span ${placement.span}`,
                }}
                title={`Blocked: ${b.reason}`}
              >
                <span className="truncate font-medium">{b.reason}</span>
              </div>
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
              <div
                key={`s-${s.id}`}
                className={`m-0.5 rounded border border-line bg-surface-2 ${accent} px-2 py-1 text-[11px] text-fg flex items-center gap-1.5 min-w-0`}
                style={{
                  gridRow: row,
                  gridColumn: `${placement.col} / span ${placement.span}`,
                }}
                title={tooltip}
              >
                <span className="truncate font-medium">{s.coachName}</span>
                {s.useType ? (
                  <span className="text-[9px] uppercase tracking-wider text-fg-subtle shrink-0">
                    {s.useType[0]}
                  </span>
                ) : null}
              </div>
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
      </div>
    </div>
  );
}

function placeOnGrid(
  startAt: Date,
  endAt: Date,
): { col: number; span: number } | null {
  // Clip to visible range so a session that runs past 10 PM still
  // renders up to the edge (rather than disappearing).
  const startSlots =
    (startAt.getHours() - FIRST_HOUR) * 2 + Math.floor(startAt.getMinutes() / 30);
  const endSlots =
    (endAt.getHours() - FIRST_HOUR) * 2 +
    Math.ceil(endAt.getMinutes() / 30);
  const clippedStart = Math.max(startSlots, 0);
  const clippedEnd = Math.min(endSlots, SLOTS);
  if (clippedEnd <= clippedStart) return null;
  return {
    col: clippedStart + 2, // +1 for label col, +1 for 1-based grid
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
