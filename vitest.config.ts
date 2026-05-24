import { defineConfig } from "vitest/config";
import path from "node:path";

// Vitest config. Lives separate from any Next.js webpack/turbopack
// build so test runs don't pull in the framework — keeps `npm test`
// fast and lets us test pure modules (billing, audit diff, schemas)
// without a server.
//
// `@/` alias mirrors tsconfig.json so test files import the same way
// production code does.
//
// Coverage uses v8 (faster + more accurate than istanbul on modern
// Node). We assert 100% on src/lib/billing.ts in the package.json
// `coverage` script — anything less should fail CI once B7 wires it.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/lib/billing.ts"],
      reporter: ["text", "json-summary"],
      thresholds: {
        lines: 100,
        statements: 100,
        functions: 100,
        branches: 100,
      },
    },
  },
});
