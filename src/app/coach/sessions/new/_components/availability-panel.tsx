"use client";

// Read-only "what's already booked" calendar shown below the
// LogSessionForm on /coach/sessions/new. Coaches see who has the
// resource before they commit a time, so the form's server-side
// overlap rejection is a rare backstop instead of a routine UX
// dead-end.
//
// Layout per Jacob's call (2026-05-25):
//   - horizontal resource tabs at the top (one per active resource)
//   - active tab two-way-bound to the form's Resource dropdown via
//     props from the parent
//   - below tabs: single horizontal strip 8 AM–10 PM showing busy
//     spans labeled with coach first names + block reasons
//   - the coach's own tentative start/end (typed in the form) shows
//     as a translucent gold "ghost" overlay so collisions are
//     obvious before submit
//
// Re-fetches via getDayAvailability whenever the date or visible
// resource changes, plus a background tick every 30s while the tab
// is visible — same pattern as src/app/admin/schedule/_components/
// auto-refresh.tsx.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { Loader2 } from "lucide-react";
import type { ResourceOption } from "../../_components/types";
import {
  getDayAvailability,
  type AvailabilityBlock,
  type AvailabilitySession,
  type DayAvailability,
} from "../availability-actions";
import { parsePfaInput } from "@/lib/timezone";

const FIRST_HOUR = 8;
const LAST_HOUR = 22;
const TOTAL_MINUTES = (LAST_HOUR - FIRST_HOUR) * 60;
const TIME_AXIS = [8, 10, 12, 14, 16, 18, 20, 22] as const;
const REFRESH_MS = 30_000;

type Props = {
  resources: ResourceOption[];
  /** Date string from form, "YYYY-MM-DD" (PFA wall-clock). */
  date: string;
  /** Resource id currently selected in the form. "" if none yet. */
  resourceId: string;
  /** Bubble back when the coach taps a tab so the form's <select> stays in sync. */
  onResourceChange: (resourceId: string) => void;
  /** Coach's typed start time "HH:MM" — drives the ghost overlay. */
  startTime: string;
  /** Coach's typed end time "HH:MM". */
  endTime: string;
};

const RESOURCE_ACCENT: Record<string, string> = {
  cage: "bg-gold",
  bullpen: "bg-success",
  weight_room: "bg-warning",
};

export function AvailabilityPanel({
  resources,
  date,
  resourceId,
  onResourceChange,
  startTime,
  endTime,
}: Props) {
  // The active tab — defaults to whatever the form has selected. When
  // the form's select is still on "" (placeholder), we default the tab
  // to the first resource so the strip has something to show.
  const activeResourceId =
    resourceId !== "" && resources.some((r) => r.id === resourceId)
      ? resourceId
      : (resources[0]?.id ?? "");
  const activeResource =
    resources.find((r) => r.id === activeResourceId) ?? null;

  const [data, setData] = useState<DayAvailability | null>(null);
  const [pending, startTransition] = useTransition();
  // Tracks the most recent fetch so a slow response from an old date
  // can't clobber a fresher response.
  const fetchSeq = useRef(0);

  const refresh = useCallback(() => {
    if (!date) return;
    const seq = ++fetchSeq.current;
    startTransition(async () => {
      try {
        const result = await getDayAvailability(date);
        if (seq === fetchSeq.current) setData(result);
      } catch {
        // The strip is best-effort. A transient failure just leaves
        // the prior snapshot in place; the form still works.
      }
    });
  }, [date]);

  // Re-fetch when the date changes.
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Background poll while tab is visible. matches /admin/schedule.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, REFRESH_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  // Compute the ghost overlay's left/width from the coach's typed
  // start/end. If either is missing/invalid, no ghost.
  const ghost = useMemo(() => {
    if (!date || !startTime || !endTime) return null;
    try {
      const start = parsePfaInput(date, startTime);
      const end = parsePfaInput(date, endTime);
      return spanFromUtc(start, end);
    } catch {
      return null;
    }
  }, [date, startTime, endTime]);

  if (resources.length === 0) {
    return null;
  }

  const sessionsForActive =
    data?.sessions.filter((s) => s.resourceId === activeResourceId) ?? [];
  const blocksForActive =
    data?.blocks.filter((b) => b.resourceId === activeResourceId) ?? [];

  return (
    <section
      aria-label="Existing bookings"
      className="mt-8 rounded-lg border border-line bg-surface"
    >
      <header className="flex items-center justify-between px-4 py-3 border-b border-line">
        <div>
          <h2 className="text-sm font-semibold text-fg">Already booked</h2>
          <p className="text-xs text-fg-muted">
            See who has what before you pick a slot.
          </p>
        </div>
        {pending ? (
          <Loader2
            aria-label="Refreshing availability"
            className="h-3.5 w-3.5 text-fg-subtle animate-spin"
          />
        ) : null}
      </header>

      {/* Resource tabs. Horizontally scrollable on mobile so 7+
          resources don't crush the layout. */}
      <div
        role="tablist"
        aria-label="Resource"
        className="flex gap-1 overflow-x-auto px-3 py-2 border-b border-line/60"
      >
        {resources.map((r) => {
          const isActive = r.id === activeResourceId;
          return (
            <button
              key={r.id}
              role="tab"
              type="button"
              aria-selected={isActive}
              onClick={() => onResourceChange(r.id)}
              className={[
                "shrink-0 inline-flex items-center gap-1.5 rounded-md px-2.5 h-8 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40",
                isActive
                  ? "bg-surface-2 text-fg"
                  : "text-fg-muted hover:text-fg hover:bg-surface-2/60",
              ].join(" ")}
            >
              <span
                aria-hidden
                className={`h-1.5 w-1.5 rounded-full ${RESOURCE_ACCENT[r.type] ?? "bg-line-strong"}`}
              />
              {r.name}
            </button>
          );
        })}
      </div>

      {/* Time strip. Single row, 8 AM – 10 PM. */}
      <div className="px-3 py-3">
        <TimeAxis />
        <div className="relative mt-1 h-12 rounded-md border border-line/60 bg-page overflow-hidden">
          {/* Quarter-day vertical guide lines so the eye can locate
              the 2-hour boundaries even when nothing's booked there. */}
          {TIME_AXIS.slice(1, -1).map((h) => (
            <div
              key={h}
              aria-hidden
              className="absolute top-0 bottom-0 w-px bg-line/40"
              style={{ left: `${((h - FIRST_HOUR) * 60 * 100) / TOTAL_MINUTES}%` }}
            />
          ))}

          {sessionsForActive.length === 0 &&
          blocksForActive.length === 0 &&
          !pending ? (
            <p className="absolute inset-0 flex items-center justify-center text-xs text-fg-subtle">
              {activeResource
                ? `${activeResource.name} is free all day`
                : "—"}
            </p>
          ) : null}

          {blocksForActive.map((b) => (
            <BlockSpan key={b.id} block={b} />
          ))}
          {sessionsForActive.map((s) => (
            <SessionSpan key={s.id} session={s} />
          ))}

          {ghost ? <GhostSpan span={ghost} /> : null}
        </div>
      </div>
    </section>
  );
}

function TimeAxis() {
  return (
    <div className="relative h-3.5">
      {TIME_AXIS.map((h, i) => {
        const left = ((h - FIRST_HOUR) * 60 * 100) / TOTAL_MINUTES;
        const align = i === 0 ? "left-0" : i === TIME_AXIS.length - 1 ? "right-0" : "";
        // First + last labels anchor to their edge so they don't clip;
        // middle labels center on their tick.
        const transform =
          i === 0 || i === TIME_AXIS.length - 1 ? "" : "-translate-x-1/2";
        return (
          <span
            key={h}
            className={`absolute top-0 text-[10px] tabular-nums text-fg-subtle ${align} ${transform}`}
            style={
              i === 0 || i === TIME_AXIS.length - 1
                ? undefined
                : { left: `${left}%` }
            }
          >
            {format12(h)}
          </span>
        );
      })}
    </div>
  );
}

function SessionSpan({ session }: { session: AvailabilitySession }) {
  const span = spanFromUtc(new Date(session.startAt), new Date(session.endAt));
  if (!span) return null;
  return (
    <div
      title={`${session.coachFirstName} · ${format12(spanStartHour(span))}${spanStartMinute(span) === 0 ? "" : `:${pad(spanStartMinute(span))}`}`}
      className="absolute top-1 bottom-1 rounded-sm border border-line bg-surface-2/90 px-1.5 py-0.5 text-[10px] text-fg overflow-hidden whitespace-nowrap"
      style={{ left: `${span.leftPct}%`, width: `${span.widthPct}%` }}
    >
      {session.coachFirstName}
    </div>
  );
}

function BlockSpan({ block }: { block: AvailabilityBlock }) {
  const span = spanFromUtc(new Date(block.startAt), new Date(block.endAt));
  if (!span) return null;
  return (
    <div
      title={`Blocked: ${block.reason}`}
      // Diagonal-stripe pattern via repeating-linear-gradient so blocks
      // visually distinguish from sessions at a glance.
      className="absolute top-1 bottom-1 rounded-sm border border-warning/40 text-[10px] text-warning overflow-hidden whitespace-nowrap px-1.5 py-0.5"
      style={{
        left: `${span.leftPct}%`,
        width: `${span.widthPct}%`,
        backgroundImage:
          "repeating-linear-gradient(135deg, rgba(245,158,11,0.18), rgba(245,158,11,0.18) 6px, transparent 6px, transparent 12px)",
      }}
    >
      {block.reason}
    </div>
  );
}

function GhostSpan({ span }: { span: Span }) {
  return (
    <div
      aria-hidden
      className="absolute top-0 bottom-0 rounded-sm border border-gold/60 bg-gold/15 pointer-events-none"
      style={{ left: `${span.leftPct}%`, width: `${span.widthPct}%` }}
    />
  );
}

type Span = {
  leftPct: number;
  widthPct: number;
  startMinutesFromFirstHour: number;
};

function spanFromUtc(startAt: Date, endAt: Date): Span | null {
  // Convert UTC instants to PFA wall-clock minutes-since-FIRST_HOUR.
  // Both endpoints clamp to the visible window so spans crossing
  // midnight or before opening still render as a partial bar inside
  // the strip.
  const startMin = utcToPfaMinutesFromFirstHour(startAt);
  const endMin = utcToPfaMinutesFromFirstHour(endAt);
  const clippedStart = Math.max(0, startMin);
  const clippedEnd = Math.min(TOTAL_MINUTES, endMin);
  if (clippedEnd <= clippedStart) return null;
  return {
    leftPct: (clippedStart / TOTAL_MINUTES) * 100,
    widthPct: ((clippedEnd - clippedStart) / TOTAL_MINUTES) * 100,
    startMinutesFromFirstHour: clippedStart,
  };
}

function utcToPfaMinutesFromFirstHour(d: Date): number {
  // toLocaleString in PFA TZ gives us the wall-clock hour/minute
  // regardless of where the client renders. Parsing back to {h, m}
  // sidesteps having to import pfaHour/pfaMinute (which are not
  // exported individually as plain helpers everywhere).
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  // 24:00 from formatToParts can mean midnight of the next day —
  // map to 24h * 60 so end-of-strip clamping works.
  const hour = h === 24 ? 24 : h;
  return (hour - FIRST_HOUR) * 60 + m;
}

function spanStartHour(span: Span): number {
  return FIRST_HOUR + Math.floor(span.startMinutesFromFirstHour / 60);
}

function spanStartMinute(span: Span): number {
  return span.startMinutesFromFirstHour % 60;
}

function format12(h: number): string {
  const ampm = h >= 12 && h < 24 ? "PM" : "AM";
  const h12 = h === 0 || h === 24 ? 12 : h > 12 ? h - 12 : h;
  return `${h12} ${ampm}`;
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}
