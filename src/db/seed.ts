// Seed orchestrator. Runs every entity seeder in dependency order.
// Each seeder is idempotent on its own; this script can be rerun
// safely as new seeders land (rate defaults in C2, etc.).
//
// Invoked via `npm run db:seed`. Loads `.env.local` so DATABASE_URL
// is available without manual exports.
//
// Seeders are imported dynamically AFTER dotenv loads — importing
// them at the top would transitively load src/db/index.ts which
// checks DATABASE_URL at module evaluation time and would throw
// before the env had a chance to land.

import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { seedResources } = await import("./seed-resources");
  await seedResources();
  console.log("[seed] complete");
}

main().catch((err) => {
  console.error("[seed] failed:", err);
  process.exit(1);
});
