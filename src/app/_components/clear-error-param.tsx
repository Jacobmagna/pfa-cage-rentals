"use client";

import { useEffect } from "react";

/**
 * Strips the `?error=` param from the sign-in URL once the banner has
 * rendered.
 *
 * WHY: the landing page derives its error banner purely from the `error`
 * search param, so a one-time failure (e.g. `?error=send-failed` from a
 * transient Resend hiccup) stuck to the URL FOREVER — a reload, back-button,
 * restored tab or saved bookmark would re-render the same red "we couldn't
 * send your sign-in link" message even though nothing was wrong. That cost a
 * real coach days of thinking sign-in was broken while her links were being
 * delivered normally.
 *
 * The banner still shows on the navigation that carried the error (it's
 * server-rendered before this effect runs) — we only rewrite the address bar
 * afterwards, via replaceState so we don't add a history entry, so the NEXT
 * load is clean. Renders nothing.
 */
export function ClearErrorParam() {
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("error")) return;
    url.searchParams.delete("error");
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, []);

  return null;
}
