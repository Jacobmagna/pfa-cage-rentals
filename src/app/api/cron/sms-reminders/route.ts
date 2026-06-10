// 1b #25 — nightly 8 AM Pacific SMS work-log reminder cron.
//
// Vercel cron hits this TWICE a day (the two DST-spanning entries in
// vercel.json), so it only does work when the current Pacific hour is 8 —
// the off-DST fire returns { status: "skipped_not_8am" } and the (coach,
// for_date) unique index makes any redundant 8 AM fire a safe no-op.
//
// This route is imported by NOTHING else — it is the only live-path entry to
// src/lib/server/sms-reminders.ts, and even it does no work while the
// capability is dormant (SMS_ENABLED unset → runSmsReminders returns
// { status: "disabled" }).
//
// AUTH: Vercel cron auto-sends `Authorization: Bearer $CRON_SECRET` when
// CRON_SECRET is set. We verify it with a timing-safe compare. If CRON_SECRET
// is unset, the route is locked (401) — copied from the data-safe cron.

import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

import { isPacific8am, runSmsReminders } from "@/lib/server/sms-reminders";

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

  // Only run at 8 AM Pacific. The two vercel.json schedules straddle DST so
  // exactly one of them lands on the 8 AM Pacific hour year-round.
  if (!isPacific8am(new Date())) {
    return NextResponse.json({ status: "skipped_not_8am" });
  }

  try {
    const summary = await runSmsReminders({ dryRun: false });
    return NextResponse.json(summary);
  } catch (err) {
    // Sentry auto-captures unhandled errors in this route via the Next
    // integration; log for the Vercel cron run log too.
    console.error("[sms-reminders] cron run failed", err);
    return NextResponse.json({ status: "error" }, { status: 500 });
  }
}
