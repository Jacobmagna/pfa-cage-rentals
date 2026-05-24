import { defineConfig } from "@playwright/test";
import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";

// Load .env.local so INTEGRATION_DATABASE_URL is available both for
// the test process (via globalSetup) and for the webServer below.
if (existsSync(".env.local")) {
  loadDotenv({ path: ".env.local" });
}

const integrationUrl = process.env.INTEGRATION_DATABASE_URL;

// Different port than `next dev` (3000) so running E2E never collides
// with a local dev server. AUTH_URL must match the actual URL so
// Auth.js's callback bookkeeping lines up.
const E2E_PORT = 3001;
const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: process.env.CI ? [["github"], ["list"]] : "list",

  use: {
    baseURL: E2E_BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  // globalSetup runs before any test: swaps process.env.DATABASE_URL
  // to the integration branch so direct Drizzle queries in spec files
  // hit the test database, not the dev one.
  globalSetup: "./tests/e2e/global-setup.ts",

  // Boot a dedicated dev server on port 3001 with the integration
  // DB. CI always starts fresh; locally we tolerate a reused server
  // if one is already running on that port (so iterating on tests
  // doesn't re-spawn Next every run).
  webServer: {
    command: `next dev -p ${E2E_PORT}`,
    url: E2E_BASE_URL,
    timeout: 90_000,
    reuseExistingServer: !process.env.CI,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      DATABASE_URL: integrationUrl ?? "",
      AUTH_SECRET:
        process.env.AUTH_SECRET ?? "e2e-test-secret-not-used-in-production",
      AUTH_URL: E2E_BASE_URL,
      // Auth.js requires these env vars to be present at boot even
      // though E2E uses cookie injection rather than the OAuth/Resend
      // flows. Placeholders are fine.
      AUTH_GOOGLE_ID:
        process.env.AUTH_GOOGLE_ID ?? "e2e-placeholder.apps.googleusercontent.com",
      AUTH_GOOGLE_SECRET:
        process.env.AUTH_GOOGLE_SECRET ?? "e2e-placeholder-secret",
      AUTH_RESEND_KEY:
        process.env.AUTH_RESEND_KEY ?? "re_e2e_placeholder",
    },
  },

  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
