// Seeds default per-30-min rates for each resource type.
// Cents come from `DEFAULT_RATES_PER_SLOT_CENTS` in src/lib/billing.ts
// — single source of truth. If Dad ever changes a default rate, edit
// it in billing.ts and rerun the seed; existing rows will NOT be
// overwritten (onConflictDoNothing on `type` PK), so the seed is
// safe to re-run after admins have made live edits.
//
// Implication: changing the constant only affects fresh DBs (CI
// dev branches, brand new deploys). Production rate changes go
// through the admin UI (H3), not this seed.

import { db } from "./index";
import { DEFAULT_RATES_PER_SLOT_CENTS, type ResourceType } from "@/lib/billing";
import { rateDefaults, type NewRateDefault } from "./schema";

const SEED_RATE_DEFAULTS: NewRateDefault[] = (
  Object.entries(DEFAULT_RATES_PER_SLOT_CENTS) as [ResourceType, number][]
).map(([type, ratePer30MinCents]) => ({ type, ratePer30MinCents }));

export async function seedRateDefaults(): Promise<void> {
  const inserted = await db
    .insert(rateDefaults)
    .values(SEED_RATE_DEFAULTS)
    .onConflictDoNothing({ target: rateDefaults.type })
    .returning({ type: rateDefaults.type, cents: rateDefaults.ratePer30MinCents });

  if (inserted.length === 0) {
    console.log(
      "[seed] rate_defaults: all 3 rows already present, nothing to insert",
    );
    return;
  }
  console.log(`[seed] rate_defaults: inserted ${inserted.length} row(s):`);
  for (const row of inserted) {
    const dollars = (row.cents / 100).toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
    });
    console.log(`  + ${row.type} → ${dollars} per 30 min`);
  }
}
