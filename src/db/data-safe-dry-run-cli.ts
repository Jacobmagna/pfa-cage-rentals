// Data-Safe Snapshot — dry-run / inspection CLI.
//
// Computes the de-identified aggregates for a completed week and PRINTS them
// as a readable table. NEVER pushes to the central store (it calls
// runSnapshot({ dryRun: true })). This is the synthetic/inspection test path:
// run it against a dev branch (or prod read replica) to eyeball exactly what
// would leave the building before flipping the capability on.
//
// Usage:
//   npm run data-safe:dry-run                 # most recent completed week
//   npm run data-safe:dry-run -- --weeks-ago 2  # 2 weeks further back
//
// If DATA_SAFE_SALT is unset, runSnapshot uses a fixed dev salt so the run
// still works for inspection — the anon coach tokens are throwaway and never
// leave this terminal.

import { config } from "dotenv";
config({ path: ".env.local" });

import { formatPfaDateMedium } from "@/lib/timezone";
import { runSnapshot } from "@/lib/data-safe/snapshot";
import type { OpFact } from "@/lib/data-safe/types";

function parseWeeksAgo(argv: string[]): number {
  const idx = argv.indexOf("--weeks-ago");
  if (idx === -1) return 0;
  const raw = argv[idx + 1];
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`--weeks-ago expects a non-negative integer, got "${raw}"`);
  }
  return n;
}

function dimsToString(dims: OpFact["dims"]): string {
  if (!dims || Object.keys(dims).length === 0) return "";
  return Object.keys(dims)
    .sort()
    .map((key) => `${key}=${dims[key]}`)
    .join(" ");
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

async function main() {
  const weeksAgo = parseWeeksAgo(process.argv.slice(2));

  const summary = await runSnapshot({ dryRun: true, weeksAgo });

  if (summary.status !== "dry-run") {
    // runSnapshot with dryRun:true always returns "dry-run"; this is a guard.
    console.log(`Unexpected status: ${summary.status}`);
    return;
  }

  const { period, facts } = summary;

  console.log("");
  console.log("=== Data-Safe Snapshot — DRY RUN (nothing pushed) ===");
  console.log(
    `Period (facility tz, Mon→Mon): ${formatPfaDateMedium(
      period.periodStart,
    )}  →  ${formatPfaDateMedium(period.periodEnd)}`,
  );
  console.log(
    `  UTC range: ${period.periodStart.toISOString()}  →  ${period.periodEnd.toISOString()}`,
  );
  console.log(`Facts emitted: ${facts.length}`);
  console.log("");

  const COL_METRIC = 28;
  const COL_SUBTYPE = 20;
  const COL_VALUE = 14;
  console.log(
    pad("METRIC", COL_METRIC) +
      pad("SUB-TYPE", COL_SUBTYPE) +
      pad("VALUE", COL_VALUE) +
      "DIMS",
  );
  console.log("-".repeat(COL_METRIC + COL_SUBTYPE + COL_VALUE + 24));

  for (const fact of facts) {
    console.log(
      pad(fact.metric, COL_METRIC) +
        pad(fact.subType ?? "", COL_SUBTYPE) +
        pad(String(fact.value), COL_VALUE) +
        dimsToString(fact.dims),
    );
  }

  // Totals / shape summary. k-suppression happens inside computeAggregates
  // (sparse coach/dim cells are dropped before they reach us), so we report
  // the de-identified shape rather than a suppressed-count we can't observe
  // here.
  const distinctMetrics = new Set(facts.map((f) => f.metric)).size;
  const coachFacts = facts.filter(
    (f) => f.dims && "anon_coach_id" in f.dims,
  ).length;
  console.log("");
  console.log("--- summary ---");
  console.log(`  total facts:        ${facts.length}`);
  console.log(`  distinct metrics:   ${distinctMetrics}`);
  console.log(`  anon-coach facts:   ${coachFacts}`);
  console.log(
    "  note: per-coach / fine-grained dim cells with count < k are already",
  );
  console.log(
    "        k-suppressed inside the aggregator; only facility-wide scalar",
  );
  console.log("        totals are k-exempt. No raw rows or PII are present.");
  console.log("");
}

main().catch((err) => {
  console.error("data-safe dry-run failed:", err);
  process.exit(1);
});
