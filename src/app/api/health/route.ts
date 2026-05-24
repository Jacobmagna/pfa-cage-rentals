// Production health endpoint. Better Stack hits this every 3 minutes.
//
// Distinguishes three failure modes so the uptime alert is actionable:
//   1. Missing/malformed required env vars → 503 with `missing: [...]`
//   2. Database unreachable (neon down, network, bad URL) → 503 with reason
//   3. Otherwise healthy → 200 with commit + environment + timestamp
//
// Why explicit DB ping vs trusting the framework to fail: silent DB
// connectivity loss (e.g. Neon's free-tier suspended an idle compute,
// or DATABASE_URL gets rotated and we forget to update Vercel) wouldn't
// surface until a real user request hits a query. Pinging here makes
// the failure visible from the uptime monitor's perspective.
//
// Why GET (no auth): public uptime monitors need to hit this without
// credentials. Body contains no sensitive data — just env keys (names,
// not values) and a commit SHA (already public via git).
//
// Why force-dynamic: must not be cached. A cached 200 from yesterday
// would tell us nothing about right-now health.

import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getMissingRequiredEnv } from "@/lib/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const missing = getMissingRequiredEnv();
  if (missing.length > 0) {
    return NextResponse.json(
      {
        status: "degraded",
        reason: "missing_or_malformed_env",
        missing: missing.map((m) => m.key),
      },
      { status: 503 },
    );
  }

  try {
    // Cheap round-trip. Neon HTTP driver: sub-100ms typical.
    await db.execute(sql`select 1`);
  } catch (err) {
    Sentry.captureException(err, {
      tags: { health_check: "db_unreachable" },
    });
    return NextResponse.json(
      {
        status: "degraded",
        reason: "db_unreachable",
      },
      { status: 503 },
    );
  }

  return NextResponse.json(
    {
      status: "ok",
      commit: process.env.VERCEL_GIT_COMMIT_SHA ?? "development",
      environment: process.env.VERCEL_ENV ?? "development",
      timestamp: new Date().toISOString(),
    },
    {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    },
  );
}
