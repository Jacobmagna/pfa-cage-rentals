import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import {
  DISPLAY_COOKIE_NAME,
  isDisplayCookieValid,
  isDisplayPasswordConfigured,
} from "@/lib/display/access";
import { DisplayBoard } from "@/app/display/schedule/_components/display-board";
import { UnlockForm } from "./_components/unlock-form";

// `pfaengine.com/video` — the human entrance to the facility TV display.
//
// WHY THIS EXISTS: `/display/schedule?key=<48 characters>` is unguessable and
// unusable. Nobody types that into a television remote. Mark asked for a URL
// short enough to say out loud, and a URL that short cannot carry a secret —
// so the secret moved into a password box and a long-lived cookie.
// ▶ The full reasoning, including why a cookie beats a real login here, is in
// lib/display/access.ts. Read it before changing the cookie lifetime.
//
// 🔴 THE ORDER OF THE TWO CHECKS BELOW IS THE WHOLE SECURITY OF THIS ROUTE.
// `DisplayBoard` queries the facility's schedule on its first line. It is
// therefore never CONSTRUCTED for a visitor who has not been let in — not
// rendered-and-hidden, not fetched-then-discarded. A refused visitor's response
// contains a password box and nothing else: no resources, no coach names, no
// times, nothing in the RSC payload to read with View Source.
//
// 🔴 AND THIS ROUTE IS PUBLIC BY DEFAULT. There is no middleware in this repo.
// Together with /display/schedule these are the only two unauthenticated
// schedule surfaces in the product; every other one sits behind requireRole or
// requireScheduleAccess. The gate here and the projection in
// lib/server/display-schedule.ts are the only two things standing between the
// facility's day and the open internet, and each is only defensible because the
// other exists.

export const metadata: Metadata = {
  title: "Facility Schedule",
  // 🔴 NOINDEX IS LOAD-BEARING, NOT HYGIENE — and it matters MORE on this route
  // than on the tokenised one, because this URL is short, memorable and
  // linkable. On 2026-08-26 a real coach was locked out of production because
  // Google had indexed a domain nobody had ever linked; "we never link it" did
  // not turn out to mean "nobody reaches it".
  robots: { index: false, follow: false, nocache: true },
};

// Never cache: the page is either a live schedule or a password box, and both
// depend on a per-request cookie. A cached render would serve one visitor's
// state to the next.
export const dynamic = "force-dynamic";
export const revalidate = 0;

type SearchParams = Promise<{ hours?: string }>;

export default async function VideoPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  // Dormant until configured, and a 404 rather than a password box: an
  // unconfigured deployment should look like a route that does not exist,
  // giving a prober nothing — same posture as the tokenised route.
  if (!isDisplayPasswordConfigured(process.env.DISPLAY_PASSWORD)) {
    notFound();
  }

  const cookie = (await cookies()).get(DISPLAY_COOKIE_NAME)?.value;
  if (!isDisplayCookieValid(cookie, process.env.DISPLAY_TOKEN)) {
    return <UnlockForm />;
  }

  const { hours } = await searchParams;
  return <DisplayBoard hours={hours} />;
}
