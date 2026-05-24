// Loaded by vitest BEFORE each test file's module graph is evaluated.
// Swaps process.env.DATABASE_URL → INTEGRATION_DATABASE_URL so the
// `@/db` import at the top of test files connects to the integration
// branch, never the dev branch we use for manual smoke testing.
//
// Intentionally has no imports from `@/` — touching `@/db` here would
// lock in the original DATABASE_URL before the swap could take effect.

import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";

if (existsSync(".env.local")) {
  loadDotenv({ path: ".env.local" });
}

const integrationUrl = process.env.INTEGRATION_DATABASE_URL;
if (!integrationUrl) {
  throw new Error(
    "INTEGRATION_DATABASE_URL is not set. " +
      "Provision a dedicated Neon branch and add the connection string to " +
      ".env.local (locally) or GitHub Actions secrets (CI).",
  );
}

if (integrationUrl === process.env.DATABASE_URL) {
  throw new Error(
    "INTEGRATION_DATABASE_URL must point to a DIFFERENT Neon branch than " +
      "DATABASE_URL. The integration suite TRUNCATEs sessions_billing, " +
      "blocked_times, and audit_log between tests — running it against the " +
      "dev branch would wipe your smoke-test data.",
  );
}

process.env.DATABASE_URL = integrationUrl;
