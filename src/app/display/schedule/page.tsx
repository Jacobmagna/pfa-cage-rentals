import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AutoRefresh } from "@/app/admin/schedule/_components/auto-refresh";
import { isDisplayTokenValid } from "@/lib/display/token";
import { computeDisplayWindow, parseDisplayHours } from "@/lib/display/window";
import { fetchDisplaySchedule } from "@/lib/server/display-schedule";
import { formatPfaDateLong, formatPfaTime12h } from "@/lib/timezone";
import { DisplayGrid } from "./_components/display-grid";
import { StaleGuard } from "./_components/stale-guard";

// The facility TV display. `/display/schedule?key=<token>&hours=<n>`
//
// 🔴 THIS IS THE ONLY UNAUTHENTICATED SCHEDULE SURFACE IN THE PRODUCT. Every
// other one (/admin/schedule, /coach/schedule, /master/schedule,
// /admin/hour-log/schedule) sits behind requireRole / requireScheduleAccess.
// There is no middleware in this repo, so a route is public by default and
// nothing structural would stop this one leaking — the two things that do are
// the token check below and the projection in lib/server/display-schedule.ts.
// Neither is optional; each is only defensible because the other exists.
//
// WHY A TOKEN AND NOT A LOGIN: a session EXPIRES. One that dies at 2 AM
// leaves a login screen on the facility wall all morning, which is the exact
// "nobody will walk over and fix it" failure this feature exists to prevent
// (and discipline rule 22 is this repo already getting bitten by silent
// session death). Details in lib/display/token.ts.

export const metadata: Metadata = {
  title: "Facility Schedule",
  // 🔴 NOINDEX IS LOAD-BEARING HERE, NOT HYGIENE. On 2026-08-26 a real coach
  // was locked out of production because Google had indexed a domain nobody
  // had ever linked — "we never link it" turned out not to mean "nobody
  // reaches it". A tokenised URL that gets crawled is a published token, and
  // this product has already learned that lesson the expensive way.
  robots: { index: false, follow: false, nocache: true },
};

// 🔴 NEVER CACHE THIS PAGE. The whole feature is "the screen is always
// sitting on the current time"; a cached render is a schedule frozen at
// whenever the cache was filled, which is the failure mode Mark described and
// asked us to prevent. It would ALSO defeat StaleGuard, whose only evidence
// that the round trip is alive is `renderedAt` changing.
export const dynamic = "force-dynamic";
export const revalidate = 0;

type SearchParams = Promise<{ key?: string; hours?: string }>;

export default async function DisplaySchedulePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;

  // Fails closed in both directions: a wrong key AND an unset/too-short
  // DISPLAY_TOKEN both land here. A 404 rather than a 401 so the route is
  // indistinguishable from one that does not exist — there is nothing to
  // probe and nothing to tell an unauthenticated visitor.
  if (!isDisplayTokenValid(params.key, process.env.DISPLAY_TOKEN)) {
    notFound();
  }

  // `now` is read ONCE and threaded through, so the window, the grid's
  // current-time marker and the freshness stamp cannot disagree with each
  // other by a few milliseconds across the render.
  const now = new Date();
  const hours = parseDisplayHours(params.hours);
  const win = computeDisplayWindow(now, hours);
  const { resources, sessions, blocks } = await fetchDisplaySchedule(win);

  return (
    <main className="relative flex h-screen flex-col overflow-hidden bg-neutral-950 text-neutral-100">
      <header className="flex shrink-0 items-baseline justify-between px-8 pt-6 pb-4">
        <div>
          <h1 className="text-4xl font-bold tracking-tight">
            {formatPfaDateLong(now)}
          </h1>
          <p className="mt-1 text-2xl text-neutral-400 tabular-nums">
            {formatPfaTime12h(win.startAt)} – {formatPfaTime12h(win.endAt)}
          </p>
        </div>
        {/* The "as of" stamp Mark asked for. It is NOT the staleness defence
            on its own — he said so explicitly, which is why StaleGuard
            exists — but it is what lets someone standing in front of the
            screen confirm at a glance that it is live. */}
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
