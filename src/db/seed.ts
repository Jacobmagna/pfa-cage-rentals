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
  // Visibility line so the operator sees WHICH DB is about to be seeded
  // before any write. Seeding is idempotent/non-destructive, so no hard
  // confirm gate — just print the target host parsed from DATABASE_URL.
  const targetHost =
    process.env.DATABASE_URL?.match(/@([^/:?]+)/)?.[1] ?? "<unknown>";
  console.log(`[seed] target DB host: ${targetHost}`);

  const { seedResources } = await import("./seed-resources");
  const { seedRateDefaults } = await import("./seed-rate-defaults");
  await seedResources();
  await seedRateDefaults();

  const { db } = await import("./index");
  const { seedAthletes, loadAthletesFromJson } = await import(
    "./seed-athletes"
  );
  const athleteInputs = loadAthletesFromJson();
  if (athleteInputs.length === 0) {
    console.log(
      "[seed] athletes: no data file at build/seed-data/athletes.json — skipping",
    );
  } else {
    const { inserted, skipped } = await seedAthletes(db, athleteInputs);
    console.log(
      `[seed] athletes: inserted ${inserted}, skipped ${skipped} (already present)`,
    );
  }

  const { seedPrograms } = await import("./seed-programs");
  const programResult = await seedPrograms(db);
  console.log(
    `[seed] programs: inserted ${programResult.inserted}, skipped ${programResult.skipped}`,
  );

  const { seedCoaches, loadCoachesFromJson } = await import("./seed-coaches");
  const coachInputs = loadCoachesFromJson();
  if (coachInputs.length === 0) {
    console.log(
      "[seed] coaches: no data file at build/seed-data/coaches.json — skipping",
    );
  } else {
    const coachResult = await seedCoaches(db, coachInputs);
    console.log(
      `[seed] coaches: inserted ${coachResult.inserted}, updated ${coachResult.updated}`,
    );
  }

  console.log("[seed] complete");
}

main().catch((err) => {
  console.error("[seed] failed:", err);
  process.exit(1);
});
