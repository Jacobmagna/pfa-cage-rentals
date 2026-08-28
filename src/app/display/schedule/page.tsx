import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isDisplayTokenValid } from "@/lib/display/token";
import { DisplayBoard } from "./_components/display-board";

// The facility TV display, TOKENISED entrance. `/display/schedule?key=<token>&hours=<n>`
//
// 📌 THERE ARE NOW TWO ENTRANCES TO THIS BOARD, and this is the older one:
//   · here                       — an unguessable key in the URL
//   · /video                     — a password box + a long-lived cookie
// Both render `DisplayBoard`; both are protected by the same projection in
// lib/server/display-schedule.ts. This route is KEPT rather than replaced
// because it needs no cookie and no typing, which makes it the reliable path
// for QA harnesses and the fallback if a TV browser will not hold state.
// ▶ The human-facing one is /video. See lib/display/access.ts for why.
//
// 🔴 THIS AND /video ARE THE ONLY UNAUTHENTICATED SCHEDULE SURFACES IN THE
// PRODUCT. Every other one (/admin/schedule, /coach/schedule, /master/schedule,
// /admin/hour-log/schedule) sits behind requireRole / requireScheduleAccess.
// There is no middleware in this repo, so a route is public by default and
// nothing structural would stop this one leaking — the two things that do are
// the token check below and the projection. Neither is optional; each is only
// defensible because the other exists.
//
// WHY A TOKEN AND NOT A LOGIN: a session EXPIRES. One that dies at 2 AM leaves
// a login screen on the facility wall all morning, which is the exact "nobody
// will walk over and fix it" failure this feature exists to prevent (and
// discipline rule 22 is this repo already getting bitten by silent session
// death). Details in lib/display/token.ts.

export const metadata: Metadata = {
  title: "Facility Schedule",
  // 🔴 NOINDEX IS LOAD-BEARING HERE, NOT HYGIENE. On 2026-08-26 a real coach
  // was locked out of production because Google had indexed a domain nobody
  // had ever linked — "we never link it" turned out not to mean "nobody
  // reaches it". A tokenised URL that gets crawled is a published token, and
  // this product has already learned that lesson the expensive way.
  robots: { index: false, follow: false, nocache: true },
};

// 🔴 NEVER CACHE THIS PAGE. The whole feature is "the screen is always sitting
// on the current time"; a cached render is a schedule frozen at whenever the
// cache was filled, which is the failure mode Mark described and asked us to
// prevent. It would ALSO defeat StaleGuard, whose only evidence that the round
// trip is alive is `renderedAt` changing.
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
  // indistinguishable from one that does not exist — there is nothing to probe
  // and nothing to tell an unauthenticated visitor.
  //
  // 🔴 THE GATE RUNS BEFORE `DisplayBoard` IS EVEN CONSTRUCTED, and that
  // ordering is the point: the board queries the schedule on its first line, so
  // rendering it in order to decide whether to show it would fetch and
  // serialize the facility's day for someone who was refused.
  if (!isDisplayTokenValid(params.key, process.env.DISPLAY_TOKEN)) {
    notFound();
  }

  return <DisplayBoard hours={params.hours} />;
}
