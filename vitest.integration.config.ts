import { defineConfig } from "vitest/config";
import path from "node:path";

// Integration tests run against a real Neon dev branch. Separate from
// vitest.config.ts (which is unit-only with a 100% coverage gate)
// because integration tests:
//   - need INTEGRATION_DATABASE_URL set (and pointed at a non-prod branch)
//   - are slower (network RTT to Neon for every DB op)
//   - aren't subject to a coverage threshold — they exercise wired
//     code paths, not isolated units
//
// Run via: `npm run test:integration`.
// Locally: put INTEGRATION_DATABASE_URL in .env.local (pointed at a
// dedicated Neon branch — must not equal DATABASE_URL).
// CI: see .github/workflows/ci.yml `integration` job; runs only when
// the secret is configured.
//
// setupFiles runs before the test file imports `@/db`, so we can swap
// process.env.DATABASE_URL = INTEGRATION_DATABASE_URL before the db
// module loads. See tests/integration/setup.ts.
//
// fileParallelism is forced off so test files run sequentially.
// TRUNCATE between tests assumes nothing else is writing to the same
// tables concurrently; two files running side-by-side would race the
// fixtures.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    setupFiles: ["./tests/integration/setup.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
