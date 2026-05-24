// Runs once before any E2E test. Swaps process.env.DATABASE_URL to
// the integration branch so spec files that import `@/db` (or the
// relative `../../src/db` path) hit the test DB, not the dev one.
//
// Same guardrails as tests/integration/setup.ts:
//   - Throw if INTEGRATION_DATABASE_URL is missing.
//   - Throw if it equals DATABASE_URL (we TRUNCATE in beforeEach —
//     pointing at the dev branch would wipe smoke-test data).

import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";

export default async function globalSetup() {
  if (existsSync(".env.local")) {
    loadDotenv({ path: ".env.local" });
  }

  const integrationUrl = process.env.INTEGRATION_DATABASE_URL;
  if (!integrationUrl) {
    throw new Error(
      "INTEGRATION_DATABASE_URL is not set. Provision a dedicated Neon " +
        "branch and add the connection string to .env.local (locally) " +
        "or GitHub Actions secrets (CI).",
    );
  }

  if (integrationUrl === process.env.DATABASE_URL) {
    throw new Error(
      "INTEGRATION_DATABASE_URL must point to a DIFFERENT Neon branch " +
        "than DATABASE_URL. The E2E suite TRUNCATEs sessions_billing, " +
        "blocked_times, and audit_log between tests — running it " +
        "against the dev branch would wipe your smoke-test data.",
    );
  }

  process.env.DATABASE_URL = integrationUrl;
}
