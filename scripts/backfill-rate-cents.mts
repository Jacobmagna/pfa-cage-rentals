// Idempotent backfill: stamp rate_per_30_min_cents on every existing
// sessions_billing row whose value is 0 (the schema default).
//
// Rate selection (mirrors billing.ts computeRate at runtime):
//   - is_online === true  -> 0
//   - resource_type override for the coach -> override
//   - else default for the resource type
//
// PRE-FLIGHT: prints a preview of what would change before any UPDATE.
// Pass `--apply` to actually mutate. Re-runnable; only touches rows
// with rate_per_30_min_cents = 0.
import { config } from "dotenv";
config({ path: ".env.local" });

const APPLY = process.argv.includes("--apply");

const { neon } = await import("@neondatabase/serverless");
const { drizzle } = await import("drizzle-orm/neon-http");
const { eq, and } = await import("drizzle-orm");

const schema = await import("@/db/schema");
const sql = neon(process.env.DATABASE_URL!);
const db = drizzle(sql, { schema });

// Load lookup tables.
const defaults = new Map<string, number>();
for (const row of await db.select().from(schema.rateDefaults)) {
  defaults.set(row.type, row.ratePer30MinCents);
}

const overrideMap = new Map<string, number>(); // key = `${coachId}:${resourceType}`
for (const row of await db.select().from(schema.coachRateOverrides)) {
  overrideMap.set(`${row.coachId}:${row.resourceType}`, row.ratePer30MinCents);
}

// Load all sessions needing backfill.
const allSessions = await db
  .select({
    id: schema.sessionsBilling.id,
    coachId: schema.sessionsBilling.coachId,
    resourceId: schema.sessionsBilling.resourceId,
    isOnline: schema.sessionsBilling.isOnline,
    rateCents: schema.sessionsBilling.ratePer30MinCents,
    coachName: schema.users.name,
    resourceType: schema.resources.type,
  })
  .from(schema.sessionsBilling)
  .leftJoin(schema.users, eq(schema.users.id, schema.sessionsBilling.coachId))
  .leftJoin(schema.resources, eq(schema.resources.id, schema.sessionsBilling.resourceId));

const needsBackfill = allSessions.filter((s) => s.rateCents === 0 && !s.isOnline);
console.log(`Total sessions: ${allSessions.length}`);
console.log(`Already stamped: ${allSessions.length - needsBackfill.length - allSessions.filter((s) => s.isOnline).length}`);
console.log(`Online (stay $0):  ${allSessions.filter((s) => s.isOnline).length}`);
console.log(`Need backfill:   ${needsBackfill.length}`);
console.log();

// Group by (coach, resource_type) for a readable preview.
const groupCounts = new Map<string, { count: number; cents: number }>();
for (const s of needsBackfill) {
  if (!s.resourceType) {
    console.warn(`SKIP session ${s.id}: missing resource_type`);
    continue;
  }
  const cents =
    overrideMap.get(`${s.coachId}:${s.resourceType}`) ??
    defaults.get(s.resourceType) ??
    0;
  if (cents === 0) {
    console.warn(`SKIP session ${s.id}: no rate resolved`);
    continue;
  }
  const key = `${s.coachName ?? "???"} :: ${s.resourceType}`;
  const prev = groupCounts.get(key);
  if (prev) {
    prev.count += 1;
    if (prev.cents !== cents) prev.cents = -1; // mark mixed
  } else {
    groupCounts.set(key, { count: 1, cents });
  }
}

console.log("Preview (coach :: resource_type -> rate × count):");
const sorted = [...groupCounts.entries()].sort();
for (const [key, val] of sorted) {
  console.log(`  ${key.padEnd(40)} $${(val.cents / 100).toFixed(2).padStart(6)} × ${val.count}`);
}

if (!APPLY) {
  console.log("\n(Preview only. Re-run with --apply to mutate.)");
  process.exit(0);
}

console.log("\nApplying updates...");
let updated = 0;
for (const s of needsBackfill) {
  if (!s.resourceType) continue;
  const cents =
    overrideMap.get(`${s.coachId}:${s.resourceType}`) ??
    defaults.get(s.resourceType) ??
    0;
  if (cents === 0) continue;
  // Defensive: only update rows still at 0 to keep this idempotent
  // across partial-failure re-runs.
  const res = await db
    .update(schema.sessionsBilling)
    .set({ ratePer30MinCents: cents })
    .where(
      and(
        eq(schema.sessionsBilling.id, s.id),
        eq(schema.sessionsBilling.ratePer30MinCents, 0),
      ),
    )
    .returning({ id: schema.sessionsBilling.id });
  if (res.length > 0) updated += 1;
}
console.log(`Updated ${updated} rows.`);
