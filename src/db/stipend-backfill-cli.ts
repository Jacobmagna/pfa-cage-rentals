// stipend SPEC §15.1 — CLI for the one-time, idempotent Sept-1 backfill.
//
// Usage (there is deliberately NO npm script — `package.json` is dirty-by-
// design in this checkout and committing it would break `npm run` for
// everyone else):
//
//   npx tsx src/db/stipend-backfill-cli.ts                      # DEV, dry run
//   npx tsx src/db/stipend-backfill-cli.ts --apply              # DEV, writes
//   npx tsx src/db/stipend-backfill-cli.ts --target prod        # PROD, dry run
//   npx tsx src/db/stipend-backfill-cli.ts --target prod --apply --confirm-prod
//
// ── 🔴 WHY THE TARGET IS AN EXPLICIT FLAG ────────────────────────────────
// `.env.local`'s `DATABASE_URL` POINTS AT PRODUCTION (MAINTENANCE-HANDOFF open
// item #12). Any script that imports `@/db` without overriding it is talking
// to prod. So this CLI resolves the URL FIRST, asserts the host matches the
// target the operator named, sets `process.env.DATABASE_URL`, and only THEN
// dynamically imports `@/db`. A static import would open the connection before
// the guard could run — which is the whole reason the import below is `await
// import(...)` rather than a top-of-file `import`.
//
// ── Three gates before a single row is written to prod ───────────────────
//   1. `--target prod` — you named it
//   2. `--apply`       — you meant to write, not to look
//   3. `--confirm-prod` — you know it is the live payroll
// Dry run is the default everywhere, and the dry run prints the exact table
// the apply would act on. READ IT before applying: this file's own history
// says seven times that green assertions do not clear a money surface.
//
// Idempotent: `UNIQUE (coach_id, period_key)` means a second run creates
// nothing. Re-run it after the deploy; re-run it if you are unsure it ran.

import { config } from "dotenv";
config({ path: ".env.local" });

type Target = "dev" | "prod";

const HOST_MARKERS: Record<Target, { must: string; mustNot: string }> = {
  dev: { must: "dawn-forest", mustNot: "purple-credit" },
  prod: { must: "purple-credit", mustNot: "dawn-forest" },
};

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function parseTarget(): Target {
  const idx = process.argv.indexOf("--target");
  if (idx === -1) return "dev";
  const raw = process.argv[idx + 1];
  if (raw !== "dev" && raw !== "prod") {
    throw new Error(`--target expects "dev" or "prod", got "${raw}"`);
  }
  return raw;
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

async function main() {
  const target = parseTarget();
  const apply = flag("apply");
  const markers = HOST_MARKERS[target];

  const url =
    target === "dev"
      ? process.env.INTEGRATION_DATABASE_URL
      : process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      target === "dev"
        ? "INTEGRATION_DATABASE_URL not set"
        : "DATABASE_URL not set",
    );
  }

  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    throw new Error("the resolved database URL is not parseable");
  }

  // Two-sided assert, both directions. A one-sided check passes if the two
  // variables are ever swapped.
  if (!host.includes(markers.must) || host.includes(markers.mustNot)) {
    throw new Error(
      `REFUSING TO RUN: --target ${target} expects a host containing ` +
        `"${markers.must}" and not "${markers.mustNot}", but got "${host}".`,
    );
  }

  if (target === "prod" && apply && !flag("confirm-prod")) {
    throw new Error(
      "REFUSING TO RUN: writing stipend earnings to PRODUCTION payroll " +
        "requires --confirm-prod as well as --apply. Run the dry run first " +
        "and READ the table it prints.",
    );
  }

  // 🔴 Set the URL BEFORE `@/db` is imported. See the module note.
  process.env.DATABASE_URL = url;

  const { backfillStipendEarnings, SANCTIONED_FLOOR } = await import(
    "@/lib/stipend/backfill"
  );
  const { fetchStipendAmountCentsForPeriod } = await import(
    "@/lib/server/hour-log-actions"
  );
  const { payPeriodLabel } = await import("@/lib/pay-period");

  console.log(`target:  ${target.toUpperCase()}`);
  console.log(`host:    ${host}`);
  console.log(`mode:    ${apply ? "APPLY (writes)" : "DRY RUN (reads only)"}`);
  console.log(`floor:   ${SANCTIONED_FLOOR.toISOString()}  (2026-09-01 PFA)\n`);

  const report = await backfillStipendEarnings({
    // Backfilled earnings are attributed to the system, not to a person — no
    // admin performed this action, and stamping one would put a name on rows
    // they never clicked. The audit row's entityType still makes them findable.
    actorUserId: "system:stipend-backfill",
    resolveAmountCents: fetchStipendAmountCentsForPeriod,
    apply,
  });

  console.log(
    `${pad("PAY PERIOD", 22)}${pad("COACH", 40)}${pad("LOGS", 6)}OUTCOME`,
  );
  console.log("-".repeat(86));
  report.candidates.forEach((c, i) => {
    const outcome = report.outcomes[i];
    const label = outcome
      ? outcome.status === "earned"
        ? `earned ${dollars(outcome.amountCents)}`
        : outcome.status
      : "(dry run)";
    console.log(
      pad(payPeriodLabel(c.period), 22) +
        pad(c.coachId, 40) +
        pad(String(c.logCount), 6) +
        label,
    );
  });
  if (report.candidates.length === 0) {
    console.log("(no posted stipend-covered hour logs at or after the floor)");
  }

  // The COUNTS, printed and read. Never a `|| echo "all clear"` — a fallback
  // like that cannot tell "nothing to do" from "the query never ran."
  console.log("\nCOUNTS");
  for (const [k, v] of Object.entries(report.counts)) {
    console.log(`  ${pad(k, 22)}${v}`);
  }

  if (report.counts.failed > 0) {
    console.log(
      `\n🔴 ${report.counts.failed} earning(s) FAILED to write. They are in ` +
        "Sentry. This backfill is idempotent — fix the cause and run it again.",
    );
    process.exit(1);
  }
  if (!apply) {
    console.log("\nDry run only. Nothing was written. Re-run with --apply.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
