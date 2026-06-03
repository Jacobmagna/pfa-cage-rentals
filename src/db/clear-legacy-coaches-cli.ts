// CLI runner for the legacy-coach soft-delete. The operator invokes this
// against the target DB (dev first, then prod) to soft-delete the LEGACY
// coach rows — role=coach users whose email is NOT in the coaches.json
// keep-set — so the admin Coaches list shows only the real seeded roster.
//
// This file DOES have side effects (it connects + can update deletedAt),
// so the reusable logic lives in clear-legacy-coaches.ts which stays
// import-safe. Mirrors src/db/clear-data-cli.ts for the neon-http +
// dotenv wiring and the dry-run/confirm guard.
//
// Safety guards (ALL required):
//   1. Print the target DB host so the operator sees exactly which DB is
//      in the crosshairs before anything happens.
//   2. Load the KEEP set from build/seed-data/coaches.json. If it is
//      EMPTY, print a loud refusal and exit WITHOUT writing — a missing
//      coaches.json must never wipe every coach.
//   3. DRY RUN by default: unless PURGE_CONFIRM === "SOFT_DELETE", just
//      preview the targets and write NOTHING.
//   4. CONFIRMED run (PURGE_CONFIRM=SOFT_DELETE): soft-delete exactly the
//      targets (set deletedAt) — reversible by clearing deletedAt.
//
// Usage:
//   Preview (no writes): DATABASE_URL=... npm run db:purge-legacy-coaches
//   Apply (soft-delete): PURGE_CONFIRM=SOFT_DELETE DATABASE_URL=... npm run db:purge-legacy-coaches
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";
import { loadCoachesFromJson } from "./seed-coaches";
import {
  findLegacyCoaches,
  softDeleteLegacyCoaches,
  type LegacyCoachTarget,
} from "./clear-legacy-coaches";

// Pull the host out of the connection string for the operator banner.
// postgres://user:pass@HOST/db?... → HOST. Best-effort: falls back to
// "<unknown>" rather than throwing, so the banner always prints.
function hostFromUrl(url: string): string {
  const match = url.match(/@([^/:?]+)/);
  return match?.[1] ?? "<unknown>";
}

function printTargets(targets: LegacyCoachTarget[]): void {
  if (targets.length === 0) {
    console.log("  (no legacy coaches found)");
    return;
  }
  for (const t of targets) {
    const when = t.createdAt.toISOString();
    console.log(`  ${when} · ${t.email} · ${t.name ?? "(no name)"}`);
  }
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");

  const host = hostFromUrl(url);
  console.log(`Target DB host: ${host}`);

  // Keep-set: lowercased coach emails from build/seed-data/coaches.json.
  const keepEmails = new Set(loadCoachesFromJson().map((c) => c.email));
  console.log(
    `Keep-set: ${keepEmails.size} coach emails from build/seed-data/coaches.json`,
  );

  if (keepEmails.size === 0) {
    console.error(
      "\nREFUSING TO RUN: keep-set is EMPTY (build/seed-data/coaches.json " +
        "missing or empty). Running would soft-delete EVERY coach. Nothing " +
        "was written. Provide the coaches.json roster and re-run.",
    );
    process.exit(1);
  }

  const sql = neon(url);
  const db = drizzle(sql, { schema });

  const confirmed = process.env.PURGE_CONFIRM === "SOFT_DELETE";

  if (!confirmed) {
    const targets = await findLegacyCoaches(db, keepEmails);
    console.log(
      `\nDRY RUN — would soft-delete ${targets.length} legacy coach(es) ` +
        "(role=coach, deletedAt IS NULL, email NOT in keep-set):",
    );
    printTargets(targets);
    console.log(
      "\nDRY RUN — set PURGE_CONFIRM=SOFT_DELETE to apply. Nothing was written.",
    );
    return;
  }

  console.log("\nPURGE_CONFIRM=SOFT_DELETE — soft-deleting legacy coaches...\n");
  const { softDeleted, targets } = await softDeleteLegacyCoaches(db, keepEmails);
  printTargets(targets);
  console.log(
    `\nSoft-deleted ${softDeleted} legacy coaches (set deletedAt). ` +
      "Reversible: clear deletedAt to restore.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
