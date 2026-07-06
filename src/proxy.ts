// Host-based routing base for the ADDITIVE travel slice (travel.pfaengine.com).
//
// Next.js 16 "proxy" convention (the renamed successor to `middleware`). Same
// request/response model; runs before routing.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// pfaengine.com (+ www, + pfacagerentals.com) is the FACILITY app and must be
// byte-identical with or without this file. travel.pfaengine.com is a separate,
// additive operator app that lives in the same repo/deployment and is routed
// here by the request Host header. Until the travel slice ships, this file is a
// pure passthrough for facility and a hard "not here yet" for the travel host —
// facility UI NEVER renders on travel.pfaengine.com.
//
// ── Contract (do not break facility) ─────────────────────────────────────────
//   • ANY non-travel host  → NextResponse.next(), unconditionally. No rewrite,
//     no redirect, no header mutation. Facility behavior is unchanged.
//   • travel host, TRAVEL_ENABLED unset/false → a lightweight 404 so the travel
//     subdomain never leaks the facility app while it's dark.
//   • travel host, TRAVEL_ENABLED=true → rewrite into the `/travel` route group
//     (owned by the travel build). This branch is the integration point the
//     travel chat wires up; it stays dark in prod until go-live.
//   • Any unexpected error → fail OPEN to facility passthrough (never 500 the
//     live facility site because of travel routing).
//
// Auth is deliberately NOT handled here: travel runs its OWN Auth.js instance
// with its OWN cookie (see docs/travel/integration-base.md). The facility
// session cookie is never read, written, or scoped by this file.
import { NextResponse, type NextRequest } from "next/server";

// A host is "travel" when its leftmost label is `travel` — covers
// travel.pfaengine.com in prod and travel.localhost:3000 in dev. Port and
// case are ignored.
function isTravelHost(host: string | null): boolean {
  if (!host) return false;
  const name = host.split(":")[0].toLowerCase();
  return name === "travel.pfaengine.com" || name.startsWith("travel.");
}

export function proxy(request: NextRequest): NextResponse {
  try {
    const host = request.headers.get("host");

    // Facility hosts: untouched. This is the overwhelming majority of traffic
    // and MUST remain a no-op.
    if (!isTravelHost(host)) {
      return NextResponse.next();
    }

    // Travel host, but the slice is dark: refuse rather than leak facility UI.
    if (process.env.TRAVEL_ENABLED !== "true") {
      return new NextResponse("Not found", { status: 404 });
    }

    // Travel host + enabled: serve the `/travel` route group (travel build owns
    // those routes). Guard against double-prefixing so nested navigations stay
    // stable.
    const url = request.nextUrl.clone();
    if (!url.pathname.startsWith("/travel")) {
      url.pathname = `/travel${url.pathname}`;
    }
    return NextResponse.rewrite(url);
  } catch {
    // Fail open to facility passthrough — travel routing must never take the
    // live facility site down.
    return NextResponse.next();
  }
}

// Run on page/navigation requests only; skip Next internals + static assets so
// the proxy never sits in the hot path for `_next/*`, the favicon, or files
// with an extension (images, fonts, etc.).
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.[^/]+$).*)"],
};
