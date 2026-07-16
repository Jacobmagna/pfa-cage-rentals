// Travel (Block 4b-2-b-3) — the autopay CRON endpoint. Vercel Cron issues a GET
// here; the handler authenticates the caller, then runs runScheduledCharges()
// (the claim-first off-session executor). SINGLE Stripe account (NO Connect).
//
// AUTH — fail-closed:
//   - CRON_SECRET unset/empty → 503 { ok:false, error:"cron_secret_unset" }. We
//     NEVER run unauthenticated: without a secret there is nothing to compare
//     against, so we refuse rather than open the money path.
//   - Otherwise the `Authorization: Bearer <token>` header is compared to
//     CRON_SECRET with a TIMING-SAFE compare (length-guard, then
//     crypto.timingSafeEqual over equal-length buffers). Mismatch/missing → 401.
//
// The actual Vercel cron SCHEDULE (vercel.json) is a shared-facility change routed
// through maintenance at go-live — this task does NOT register the schedule, only
// the endpoint. The Orchestrator hand-invokes it with the Bearer secret to prove it.

import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";

import { runScheduledCharges } from "@/travel/scheduled-charges";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Constant-time string compare; false on any length mismatch (no length leak). */
function timingSafeStrEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  // Fail-closed: no secret configured → the endpoint is LOCKED, never open.
  if (!secret || secret.trim().length === 0) {
    return NextResponse.json(
      { ok: false, error: "cron_secret_unset" },
      { status: 503 },
    );
  }

  const provided = req.headers.get("authorization") ?? "";
  if (!timingSafeStrEqual(provided, `Bearer ${secret}`)) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }

  try {
    const summary = await runScheduledCharges();
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    // A failed run must be visible/retryable — capture + 500 (not a silent 200).
    Sentry.captureException(err, {
      tags: { cron: "travel-scheduled-charges" },
    });
    return NextResponse.json(
      { ok: false, error: "run_failed" },
      { status: 500 },
    );
  }
}
