import type {
  DisplayBlock,
  DisplayResource,
  DisplaySession,
} from "@/lib/server/display-schedule";
import type { DisplayWindow } from "@/lib/display/window";
import { slotIndexFor, slotStarts } from "@/lib/display/window";
import { formatPfaTime12h } from "@/lib/timezone";

// The TV rendering. Rows = resources, columns = 30-minute slots, same mental
// model as the admin grid — but this is a SEPARATE component and that is
// deliberate.
//
// 🔴 WHY NOT REUSE `ScheduleGrid`: that component is 892 lines of drag-and-
// drop, click-to-create, edit dialogs and server actions. Everything that
// makes it good for an admin at a desk is dead weight or a liability on a
// wall screen nobody touches, and bending it to serve both would put the
// admin's live schedule in this feature's blast radius for no benefit. The
// shared thing worth sharing is the DATA SHAPE, and that is shared.
//
// 🔴 THIS IS A SERVER COMPONENT AND THAT IS A SECURITY PROPERTY, NOT A
// PERFORMANCE ONE. DO NOT ADD `"use client"` TO THIS FILE without re-reading
// the header of src/lib/server/display-schedule.ts first. Probed and measured
// 2026-08-27: props passed to a SERVER component are rendered away and never
// reach the page source, while props passed to a CLIENT component are
// serialized into the RSC payload and ARE readable by anyone with the URL —
// rendered or not. The moment this component goes client-side, every field in
// the display projection becomes published. The projection is deliberately
// narrow so that day stays safe, but the two facts are coupled and only this
// comment says so.
//
// No state, no effects, no interactivity. The only client code on the page is
// AutoRefresh and StaleGuard, and StaleGuard receives one timestamp.
//
// LEGIBILITY IS THE REQUIREMENT, not density. Mark asked for 3–5 hours rather
// than the whole day specifically so "anyone can read it or see it easily",
// so type is large, contrast is high, and the palette is dark because a wall
// screen glowing warm-white all day is fatiguing in a room with no windows.

/** Per-resource-type accent, carried over from the admin grid's convention
 *  (cage = gold, bullpen = success, weight room = warning) but re-picked for
 *  legibility on a dark background — the app's #166534 and #9a5208 are tuned
 *  for near-black text on warm off-white and go muddy here. */
const TYPE_ACCENT: Record<string, string> = {
  cage: "#FFC400",
  bullpen: "#4ADE80",
  weight_room: "#FB923C",
};

/** Blocked-out time: a red OUTLINE, not a red slab.
 *
 *  🔴 THE HISTORY MATTERS, BECAUSE THIS IS THE SECOND TIME THIS HAS MOVED.
 *  It began as `bg-neutral-800` — dark grey on near-black — and on the actual
 *  wall it was effectively invisible: an unavailable cage read as a FREE one,
 *  the single thing a booking screen must never do. Found by looking at a
 *  photograph, not by an assertion (rule 8). It was then made a loud solid red
 *  fill (#DC2626) to fix exactly that.
 *
 *  🔴 WHY GOING BACK TO A LIGHTER TREATMENT IS SAFE NOW, AND WOULD NOT HAVE
 *  BEEN THEN. Requested 2026-08-30 (Mark's wife via Jacob) together with the
 *  change that gives these bars a real LABEL. That pairing is the whole
 *  argument: the original failure was an EMPTY dark shape reading as empty
 *  space, and a bar carrying a program name in bright red is not empty. The
 *  outline is doing less work than it used to because the text now shares it.
 *
 *  ⚠️ IF THE LABEL EVER GOES AWAY, THIS MUST GO BACK TO A SOLID FILL. An
 *  outlined bar with no text in it is the 2026-08-27 bug again.
 *
 *  ⚠️ The wash is a deliberate hedge, not decoration: at 14% the interior is
 *  still plainly "not empty" from across the room while reading as an outline
 *  rather than a slab. Delete it and the bars are pure outline — Mark's or his
 *  wife's to call once they have seen it on the wall.
 *
 *  ⚠️ The BORDER keeps #DC2626 — the established red, deliberately not the
 *  app's muddy `--danger` (#B01818) and deliberately separable from the
 *  weight-room accent (#FB923C). The TEXT is lifted to #F87171 because #DC2626
 *  on #0A0A0A is only 4.10:1; #F87171 is 7.15:1 and survives being read from
 *  across a room. */
const BLOCKED_OUTLINE = "#DC2626";
const BLOCKED_WASH = "rgba(220, 38, 38, 0.14)";
const BLOCKED_TEXT = "#F87171";

// 🔴 NO FIXED ROW HEIGHT. The grid fills the viewport and the rows divide
// whatever is left, because a TV does not scroll: with a fixed height, the
// tenth resource simply falls off the bottom of the wall and is invisible.
// Found by looking at the screen -- ten resources at 6.25rem overflowed
// 1080p. Now the row height is whatever makes them all fit.

export function DisplayGrid({
  win,
  resources,
  sessions,
  blocks,
  now,
}: {
  win: DisplayWindow;
  resources: DisplayResource[];
  sessions: DisplaySession[];
  blocks: DisplayBlock[];
  now: Date;
}) {
  const columns = slotStarts(win);

  // Where the "now" marker sits, as a fraction across the window. Rendered as
  // a percentage rather than snapped to a column so it drifts smoothly
  // between refreshes instead of jumping every half hour.
  const nowFraction =
    (now.getTime() - win.startAt.getTime()) /
    (win.endAt.getTime() - win.startAt.getTime());
  const showNowMarker = nowFraction >= 0 && nowFraction <= 1;

  if (resources.length === 0) {
    return (
      <p className="px-10 py-20 text-3xl text-neutral-500">
        No active cages, bullpens or weight-room slots are configured.
      </p>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col px-8 pb-8">
      <div
        className="grid min-h-0 flex-1"
        style={{
          gridTemplateColumns: `17rem repeat(${win.slotCount}, minmax(0, 1fr))`,
          gridTemplateRows: `auto repeat(${resources.length}, minmax(0, 1fr))`,
        }}
      >
        {/* ── time axis ─────────────────────────────────────────────── */}
        <div className="sticky left-0 z-10" />
        {columns.map((slot, i) => (
          <div
            key={slot.toISOString()}
            className="border-l border-neutral-800 pb-3 pl-2 text-left text-2xl font-semibold tabular-nums text-neutral-400"
          >
            {/* 🔴 LEFT-ALIGNED, NOT CENTRED, AND THAT IS A CORRECTNESS FIX
                RATHER THAN A STYLE CHOICE. A bar for a 2:30 booking is
                positioned at the LEFT EDGE of its column, so a label centred
                in that column sits half a slot — fifteen minutes — to the
                right of the thing it names. Every start time on the wall
                reads late. Found by looking at the rendered screen, not by
                any assertion (discipline rule 8).

                Only the top of each hour is labelled: labelling every 30
                minutes doubles the ink for information a viewer across the
                room cannot use anyway. */}
            {i % 2 === 0 ? formatPfaTime12h(slot) : ""}
          </div>
        ))}

        {/* ── one row per resource ──────────────────────────────────── */}
        {resources.map((resource) => {
          const accent = TYPE_ACCENT[resource.type] ?? "#FFC400";
          const rowSessions = sessions.filter((s) => s.resourceId === resource.id);
          const rowBlocks = blocks.filter((b) => b.resourceId === resource.id);

          return (
            <RowFragment
              key={resource.id}
              resource={resource}
              accent={accent}
              rowSessions={rowSessions}
              rowBlocks={rowBlocks}
              win={win}
            />
          );
        })}
      </div>

      {showNowMarker ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 w-[3px] bg-red-500/80"
          style={{
            // 17rem is the resource-name gutter (and px-8 = 2rem either
            // side); the marker is positioned within the remaining track.
            // ⚠️ These three numbers must match the grid template above —
            // change one and the "now" line drifts away from the columns it
            // is supposed to be pointing at.
            left: `calc(2rem + 17rem + (100% - 4rem - 17rem) * ${nowFraction})`,
          }}
        />
      ) : null}
    </div>
  );
}

function RowFragment({
  resource,
  accent,
  rowSessions,
  rowBlocks,
  win,
}: {
  resource: DisplayResource;
  accent: string;
  rowSessions: DisplaySession[];
  rowBlocks: DisplayBlock[];
  win: DisplayWindow;
}) {
  return (
    <>
      <div
        className="flex items-center whitespace-nowrap border-b border-neutral-800 pr-4 text-3xl font-semibold text-neutral-200"
        style={{ borderLeft: `6px solid ${accent}`, paddingLeft: "1rem" }}
      >
        {resource.name}
      </div>

      {/* The lane. One grid cell spanning every slot, with bars placed inside
          it by their own column spans — the same CSS-grid approach the admin
          grid uses, so a multi-slot booking reads as one continuous bar
          rather than as a run of adjacent boxes. */}
      <div
        className="relative min-h-0 border-b border-neutral-800"
        style={{ gridColumn: `2 / span ${win.slotCount}` }}
      >
        <div
          className="grid h-full"
          style={{ gridTemplateColumns: `repeat(${win.slotCount}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: win.slotCount }, (_, i) => (
            <div key={i} className="border-l border-neutral-800/60" />
          ))}
        </div>

        {rowBlocks.map((block) => (
          <Bar
            key={block.id}
            startAt={block.startAt}
            endAt={block.endAt}
            win={win}
            style={{
              backgroundColor: BLOCKED_WASH,
              border: `2px solid ${BLOCKED_OUTLINE}`,
              color: BLOCKED_TEXT,
            }}
            label={block.label}
          />
        ))}

        {rowSessions.map((session) => (
          <Bar
            key={session.id}
            startAt={session.startAt}
            endAt={session.endAt}
            win={win}
            className="text-neutral-950"
            style={{ backgroundColor: accent }}
            label={session.coachLabel}
            sublabel={session.isGroupSession ? "Group" : undefined}
          />
        ))}
      </div>
    </>
  );
}

function Bar({
  startAt,
  endAt,
  win,
  className,
  style,
  label,
  sublabel,
}: {
  startAt: Date;
  endAt: Date;
  win: DisplayWindow;
  className?: string;
  style?: React.CSSProperties;
  label: string;
  sublabel?: string;
}) {
  // 🔴 CLAMP HERE, NOT IN slotIndexFor. The index is deliberately allowed to
  // go negative so this component can tell "starts before the window" from
  // "starts at the first column" — a booking already in progress renders as
  // running off the left edge, which is honest, rather than being slid to the
  // start and lying about when it began.
  const rawStart = slotIndexFor(startAt, win.startAt);
  const rawEnd = slotIndexFor(new Date(endAt.getTime() - 1), win.startAt) + 1;

  const startSlot = Math.max(0, rawStart);
  const endSlot = Math.min(win.slotCount, rawEnd);
  const span = endSlot - startSlot;
  if (span <= 0) return null;

  const cutLeft = rawStart < 0;
  const cutRight = rawEnd > win.slotCount;

  return (
    <div
      className={`absolute inset-y-1 flex items-center gap-3 overflow-hidden px-4 ${
        cutLeft ? "" : "rounded-l-lg"
      } ${cutRight ? "" : "rounded-r-lg"} ${className ?? ""}`}
      style={{
        left: `${(startSlot / win.slotCount) * 100}%`,
        width: `${(span / win.slotCount) * 100}%`,
        ...style,
      }}
    >
      {/* 🔴 ONE LINE, NOT TWO, AND THAT IS A CORRECTNESS FIX RATHER THAN A
          STYLE PREFERENCE. The sublabel used to sit UNDER the name in a
          flex-col. Rows have no fixed height — they divide whatever vertical
          space is left after the header (see the note above RowFragment) — so
          once enough resources are configured the row is shorter than the two
          stacked lines, and `justify-center` + `overflow-hidden` crops the
          pair from BOTH ends: the name loses its descenders and "Group" is
          sheared off, the two reading as one smeared line. Photographed on the
          real screen 2026-08-27 (rule 8 again — no assertion could see it).

          A single row cannot do that at ANY row height, which is the point:
          the fix is structural, not a tuned font size that breaks again the
          next time Mark adds a cage. `min-w-0` is what lets the name actually
          truncate inside a flex row, and the marker is `shrink-0` so the thing
          that gets shortened is the long name, never the one-word tag. */}
      <span className="min-w-0 truncate text-3xl font-bold leading-tight">{label}</span>
      {sublabel ? (
        <span className="shrink-0 rounded-md bg-black/20 px-2.5 py-0.5 text-xl font-semibold leading-none">
          {sublabel}
        </span>
      ) : null}
    </div>
  );
}
