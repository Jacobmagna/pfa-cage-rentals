// CLI runner for the data-clear. The Orchestrator invokes this against
// the target DB (dev first, then prod). It mirrors src/db/migrate.ts for
// the neon-http + dotenv wiring.
//
// This file DOES have side effects (it connects + can delete), so the
// reusable logic lives in clear-data.ts which stays import-safe.
//
// Safety guards (ALL required, see below):
//   1. Print the target DB host so the operator sees exactly which DB
//      is in the crosshairs before anything happens.
//   2. Refuse to delete unless CLEAR_CONFIRM === "DELETE". Without it
//      this is a dry-run/preview: print the host + the would-delete
//      table list and exit 1 WITHOUT touching the DB.
//   3. On a confirmed run: clearData(), print a BEFORE→AFTER table for
//      every DELETE and KEEP table, then assert every DELETE table is 0
//      and every KEEP count is unchanged. Exit 1 on any violation.
//
// Usage:
//   Preview (no delete):   DATABASE_URL=... npm run db:clear
//   Confirmed clear:       CLEAR_CONFIRM=DELETE DATABASE_URL=... npm run db:clear
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { clearData, DELETE_ORDER, KEEP_TABLES } from "./clear-data";

// Pull the host out of the connection string for the operator banner.
// postgres://user:pass@HOST/db?... → HOST. Best-effort: falls back to
// "<unknown>" rather than throwing, so the banner always prints.
function hostFromUrl(url: string): string {
  const match = url.match(/@([^/:?]+)/);
  return match?.[1] ?? "<unknown>";
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");

  const host = hostFromUrl(url);
  console.log(`Target DB host: ${host}`);

  const confirmed = process.env.CLEAR_CONFIRM === "DELETE";

  if (!confirmed) {
    console.log(
      "\nDRY RUN — CLEAR_CONFIRM is not set to \"DELETE\". Nothing will be deleted.",
    );
    console.log("Would DELETE all rows from these tables (in order):");
    DELETE_ORDER.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
    console.log("\nWould KEEP (untouched):");
    KEEP_TABLES.forEach((t) => console.log(`  - ${t}`));
    console.log(
      "\nTo actually clear, re-run with CLEAR_CONFIRM=DELETE prepended.",
    );
    process.exit(1);
  }

  const sql = neon(url);
  const db = drizzle(sql);

  console.log("\nCLEAR_CONFIRM=DELETE — clearing data...\n");
  const { before, after } = await clearData(db);

  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(pad("TABLE", 28) + pad("KIND", 8) + pad("BEFORE", 10) + "AFTER");
  console.log("-".repeat(54));
  for (const t of DELETE_ORDER) {
    console.log(
      pad(t, 28) + pad("DELETE", 8) + pad(String(before[t]), 10) + String(after[t]),
    );
  }
  for (const t of KEEP_TABLES) {
    console.log(
      pad(t, 28) + pad("KEEP", 8) + pad(String(before[t]), 10) + String(after[t]),
    );
  }

  // Assertions: every DELETE table is now 0; every KEEP table unchanged.
  const deleteViolations = DELETE_ORDER.filter((t) => after[t] !== 0);
  const keepViolations = KEEP_TABLES.filter((t) => before[t] !== after[t]);

  console.log();
  if (deleteViolations.length === 0 && keepViolations.length === 0) {
    console.log(
      "OK: all DELETE tables are 0 and all KEEP tables are unchanged.",
    );
  } else {
    if (deleteViolations.length > 0) {
      console.error(
        `FAIL: DELETE tables not empty: ${deleteViolations
          .map((t) => `${t}=${after[t]}`)
          .join(", ")}`,
      );
    }
    if (keepViolations.length > 0) {
      console.error(
        `FAIL: KEEP tables changed: ${keepViolations
          .map((t) => `${t} ${before[t]}->${after[t]}`)
          .join(", ")}`,
      );
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
