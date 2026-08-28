import { AutoRefresh } from "@/app/admin/schedule/_components/auto-refresh";
import { computeDisplayWindow, parseDisplayHours } from "@/lib/display/window";
import { fetchDisplaySchedule } from "@/lib/server/display-schedule";
import { formatPfaDateLong, formatPfaTime12h } from "@/lib/timezone";
import { DisplayGrid } from "./display-grid";
import { StaleGuard } from "./stale-guard";

// The board itself — everything that renders once a viewer has been let in.
//
// 🔴 EXTRACTED SO THE TWO ENTRANCES CANNOT DRIFT. There are two ways to reach
// this screen and they authenticate completely differently:
//
//   · /display/schedule?key=<token>  — the unguessable URL (lib/display/token.ts)
//   · /video                         — a password box + a cookie (lib/display/access.ts)
//
// What they must NOT differ on is what gets rendered, and in particular the
// PII posture: the projection in lib/server/display-schedule.ts is the boundary
// for BOTH, and a second copy of this JSX is how one entrance quietly grows a
// field the other does not have. One board, two doors.
//
// 🔴 THIS IS A SERVER COMPONENT AND THAT IS A SECURITY PROPERTY. Read the
// header of display-grid.tsx before adding `"use client"` here: props handed to
// a server component are rendered away, props handed to a CLIENT component are
// serialized into the RSC payload and readable by anyone who can load the page.
// Everything on this screen is schedule data. The only client components on it
// are AutoRefresh (no props) and StaleGuard (one timestamp).
//
// ⚠️ THE CALLER IS RESPONSIBLE FOR THE GATE, AND FOR NOT CALLING THIS AT ALL
// WHEN THE GATE FAILS. `fetchDisplaySchedule` runs on the first line below, so
// rendering this to decide whether to show it would query and serialize the
// facility's schedule for a visitor who was never let in.

export async function DisplayBoard({ hours }: { hours: string | undefined }) {
  // `now` is read ONCE and threaded through, so the window, the grid's
  // current-time marker and the freshness stamp cannot disagree with each
  // other by a few milliseconds across the render.
  const now = new Date();
  const win = computeDisplayWindow(now, parseDisplayHours(hours));
  const { resources, sessions, blocks } = await fetchDisplaySchedule(win);

  return (
    <main className="relative flex h-screen flex-col overflow-hidden bg-neutral-950 text-neutral-100">
      <header className="flex shrink-0 items-baseline justify-between px-8 pt-6 pb-4">
        <div>
          <h1 className="text-4xl font-bold tracking-tight">{formatPfaDateLong(now)}</h1>
          <p className="mt-1 text-2xl text-neutral-400 tabular-nums">
            {formatPfaTime12h(win.startAt)} – {formatPfaTime12h(win.endAt)}
          </p>
        </div>
        {/* The "as of" stamp Mark asked for. It is NOT the staleness defence on
            its own — he said so explicitly, which is why StaleGuard exists —
            but it is what lets someone standing in front of the screen confirm
            at a glance that it is live. */}
        <p className="text-2xl font-semibold tabular-nums text-neutral-500">
          as of {formatPfaTime12h(now)}
        </p>
      </header>

      <DisplayGrid
        win={win}
        resources={resources}
        sessions={sessions}
        blocks={blocks}
        now={now}
      />

      {/* Already in production and already mounted by /master/schedule: polls
          every 30s via router.refresh(), which re-runs this server component
          and diffs the result in — no full reload, no flicker. Because the
          window above is computed from `now` on every render, that existing
          poll is what makes the schedule advance itself. */}
      <AutoRefresh />
      <StaleGuard renderedAt={now.toISOString()} />
    </main>
  );
}
