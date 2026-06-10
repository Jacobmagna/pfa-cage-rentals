// Weekly Data-Safe Snapshot cron (Vercel cron → Mon 08:00 UTC; see
// vercel.json). De-identified operational aggregates for the most recent
// COMPLETED week are appended to Magna's central store.
//
// This route is imported by NOTHING else — it is the only live-path entry to
// src/lib/data-safe/*, and even it does no work while the capability is
// dormant (DATA_SAFE_ENABLED unset → runSnapshot returns {status:"disabled"}).
//
// AUTH: Vercel cron auto-sends `Authorization: Bearer $CRON_SECRET` when
// CRON_SECRET is set. We verify it with a timing-safe compare. If CRON_SECRET
// is unset, the route is locked (401) — no anonymous trigger.

import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

import { runSnapshot } from "@/lib/data-safe/snapshot";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Constant-time string compare; false on any length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // No secret configured → the cron endpoint is locked, not open.
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const provided = req.headers.get("authorization") ?? "";
  if (!safeEqual(provided, `Bearer ${secret}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const summary = await runSnapshot({ dryRun: false });
    return NextResponse.json(summary);
  } catch (err) {
    // Sentry auto-captures unhandled errors in this route via the Next
    // integration; log for the Vercel cron run log too.
    console.error("[data-safe-snapshot] cron run failed", err);
    return NextResponse.json({ status: "error" }, { status: 500 });
  }
}
