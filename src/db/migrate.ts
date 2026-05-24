// Apply pending Drizzle migrations against Neon.
//
// Uses Drizzle's official `migrate()` from drizzle-orm/neon-http/migrator,
// which tracks applied migrations in a `__drizzle_migrations` table and
// only runs pending ones. Idempotent — safe to call on every deploy.
//
// Local: load `.env.local` so DATABASE_URL is available without manual exports.
// Vercel: env vars are already in process.env via the build environment —
// the dotenv call is a harmless no-op when the file doesn't exist.
//
// Runs via:
//   - `npm run db:migrate`  — local invocation
//   - `npm run vercel-build` — first step of Vercel deploys (package.json),
//     so every deploy applies pending migrations before next build. Failures
//     here block the deploy entirely, which is the correct behavior: a
//     broken migration must not be paired with code that assumes the new
//     schema.
import { config } from "dotenv";
config({ path: ".env.local" });

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");

  const sql = neon(url);
  const db = drizzle(sql);

  console.log("Applying pending migrations...");
  await migrate(db, { migrationsFolder: "drizzle" });
  console.log("Migrations up to date.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
