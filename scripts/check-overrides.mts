import { config } from "dotenv";
config({ path: ".env.local" });

const { db } = await import("@/db");
const { coachRateOverrides, users, rateDefaults, sessionsBilling } = await import("@/db/schema");
import { eq, sql } from "drizzle-orm";

const overrides = await db
  .select({
    coachId: coachRateOverrides.coachId,
    name: users.name,
    email: users.email,
    resourceType: coachRateOverrides.resourceType,
    rate: coachRateOverrides.ratePer30MinCents,
  })
  .from(coachRateOverrides)
  .leftJoin(users, eq(coachRateOverrides.coachId, users.id))
  .orderBy(users.name);

console.log("=== coach_rate_overrides ===");
for (const o of overrides) {
  console.log(
    `${(o.name ?? "???").padEnd(30)} (${(o.email ?? "???").padEnd(40)}) ${o.resourceType.padEnd(12)} $${(o.rate / 100).toFixed(2)}`,
  );
}

console.log("\n=== rate_defaults ===");
const defaults = await db.select().from(rateDefaults);
for (const d of defaults) {
  console.log(`${d.type.padEnd(12)} $${(d.ratePer30MinCents / 100).toFixed(2)}`);
}

console.log("\n=== sessions_billing count ===");
const count = await db.select({ c: sql<number>`count(*)::int` }).from(sessionsBilling);
console.log(`rows: ${count[0]?.c}`);
