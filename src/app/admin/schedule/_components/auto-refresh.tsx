"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Polls every 30s by calling router.refresh(), which re-runs the
// server component fetch and diffs the new tree into the DOM.
// Cheaper + simpler than SWR for a server-rendered page — the
// alternative would have meant client-fetching the entire grid's
// data via a route handler.
//
// 30s interval matches the F2 acceptance: opening the schedule in
// two tabs and creating a session in one should show up in the
// other within 30s. Push-based real-time (SSE, Pusher, Ably) is
// deferred until Phase 6+ per the spec.
//
// Re-renders are server-rendered diffs; no full page reload, no
// scroll-position loss, and Next.js dedupes the fetch if the user
// is already navigating away.

const INTERVAL_MS = 30_000;

export function AutoRefresh() {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => {
      // Pause polling when the tab is hidden — saves CPU/bandwidth
      // and prevents a flood of refreshes when the user returns to
      // a long-backgrounded tab.
      if (document.visibilityState !== "visible") return;
      router.refresh();
    }, INTERVAL_MS);
    return () => clearInterval(id);
  }, [router]);
  return null;
}
