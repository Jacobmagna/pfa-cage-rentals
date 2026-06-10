// Demo-video DB helper. THROWAWAY SALES ASSET pipeline.
//
// HARD GUARDRAIL: every DB connection this pipeline opens MUST point at
// the INTEGRATION branch (host contains "dawn-forest"). We resolve the
// URL from INTEGRATION_DATABASE_URL, assert the host, and ABORT loudly
// otherwise. We never read DATABASE_URL here (that is PROD,
// ep-purple-credit) so an accidental prod write is impossible by
// construction.

import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "../../src/db/schema";

const REQUIRED_HOST_FRAGMENT = "dawn-forest";

/** postgres://user:pass@HOST/db?... → HOST (best-effort). */
export function hostFromUrl(url: string): string {
  return url.match(/@([^/:?]+)/)?.[1] ?? "<unknown>";
}

/**
 * The integration connection string, asserted to point at the
 * dawn-forest (integration) branch. Throws — and the caller should let
 * the process die — if it is missing or points anywhere else.
 */
export function integrationUrl(): string {
  const url = process.env.INTEGRATION_DATABASE_URL;
  if (!url) {
    throw new Error(
      "INTEGRATION_DATABASE_URL is not set. Demo pipeline only runs against " +
        "the integration branch.",
    );
  }
  const host = hostFromUrl(url);
  if (!host.includes(REQUIRED_HOST_FRAGMENT)) {
    throw new Error(
      `REFUSING TO RUN: resolved DB host "${host}" does not contain ` +
        `"${REQUIRED_HOST_FRAGMENT}". The demo pipeline writes ONLY to the ` +
        `integration branch. ABORT.`,
    );
  }
  return url;
}

/** Prints the guarded host banner and returns a drizzle handle on it. */
export function demoDb() {
  const url = integrationUrl();
  console.log(`[demo] guarded DB host: ${hostFromUrl(url)} (integration)`);
  const sql = neon(url);
  return drizzle(sql, { schema });
}

export { schema };
export type DemoDb = ReturnType<typeof demoDb>;
