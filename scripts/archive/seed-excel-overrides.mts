// Idempotent seed: align rate_defaults + coach_rate_overrides with Dad's Excel
// (verified 2026-05-25). Safe to re-run — each step checks state first.
//
// Excel rates:
//   - Default cage:        $22.00 (already set, no-op)
//   - Default bullpen:     $22.00 (already set, no-op)
//   - Default weight_room: $7.00  (currently $5.00 — fix it)
//   - Discount cage $17:   Fry, Iniguez, Gomez, Parker, Sanchez, Leon
//   - Lusk cage:           $15.00
//   - Gonzalez cage:       $10.00
//
// Audit-logged under Jacob's user id. Run BEFORE the rate_cents backfill.
import { config } from "dotenv";
config({ path: ".env.local" });

import { randomUUID } from "node:crypto";

const { neon } = await import("@neondatabase/serverless");
const { drizzle } = await import("drizzle-orm/neon-http");
const { eq, and } = await import("drizzle-orm");

const schema = await import("@/db/schema");
const sql = neon(process.env.DATABASE_URL!);
const db = drizzle(sql, { schema });

// Jacob is the actor for the seed audit entries.
const [actor] = await db
  .select()
  .from(schema.users)
  .where(eq(schema.users.email, "jacob@docinsured.com"));
if (!actor) throw new Error("Could not find Jacob's user row to use as audit actor");

console.log(`Actor: ${actor.name} (${actor.id})`);

// --- 1. Default weight_room rate $5 -> $7 ---
const [wr] = await db
  .select()
  .from(schema.rateDefaults)
  .where(eq(schema.rateDefaults.type, "weight_room"));
const targetWeightRoom = 700;
if (wr && wr.ratePer30MinCents !== targetWeightRoom) {
  console.log(`Updating rate_defaults.weight_room: $${(wr.ratePer30MinCents / 100).toFixed(2)} -> $${(targetWeightRoom / 100).toFixed(2)}`);
  await db
    .update(schema.rateDefaults)
    .set({ ratePer30MinCents: targetWeightRoom, updatedAt: new Date() })
    .where(eq(schema.rateDefaults.type, "weight_room"));
  await db.insert(schema.auditLog).values({
    actorUserId: actor.id,
    entityType: "rate_default",
    entityId: "weight_room",
    action: "update",
    diff: { before: { ratePer30MinCents: wr.ratePer30MinCents }, after: { ratePer30MinCents: targetWeightRoom } },
  });
} else {
  console.log("rate_defaults.weight_room already $7 — no-op");
}

// --- 2. Remove leftover test override ---
const testOverrides = await db
  .select()
  .from(schema.coachRateOverrides)
  .leftJoin(schema.users, eq(schema.users.id, schema.coachRateOverrides.coachId));
for (const row of testOverrides) {
  const isTest = row.users?.email?.endsWith("@test.local");
  if (isTest) {
    console.log(`Removing test override: ${row.users?.name} ${row.coach_rate_overrides.resourceType} $${(row.coach_rate_overrides.ratePer30MinCents / 100).toFixed(2)}`);
    await db
      .delete(schema.coachRateOverrides)
      .where(
        and(
          eq(schema.coachRateOverrides.coachId, row.coach_rate_overrides.coachId),
          eq(schema.coachRateOverrides.resourceType, row.coach_rate_overrides.resourceType),
        ),
      );
    await db.insert(schema.auditLog).values({
      actorUserId: actor.id,
      entityType: "rate_override",
      entityId: `${row.coach_rate_overrides.coachId}:${row.coach_rate_overrides.resourceType}`,
      action: "delete",
      diff: { before: { ratePer30MinCents: row.coach_rate_overrides.ratePer30MinCents } },
    });
  }
}

// --- 3. Create synthetic users for missing Excel coaches ---
function syntheticEmailFor(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `historical-${slug || "unknown"}@imported.local`;
}

async function ensureUser(name: string): Promise<string> {
  const email = syntheticEmailFor(name);
  const [existing] = await db.select().from(schema.users).where(eq(schema.users.email, email));
  if (existing) return existing.id;
  const id = randomUUID();
  await db.insert(schema.users).values({ id, name, email, role: "coach" });
  await db.insert(schema.auditLog).values({
    actorUserId: actor.id,
    entityType: "user",
    entityId: id,
    action: "create",
    diff: { after: { name, email, role: "coach", synthetic: true } },
  });
  console.log(`Created synthetic user: ${name} (${id})`);
  return id;
}

const gomezId = await ensureUser("Gomez");
const sanchezId = await ensureUser("Sanchez");
const gonzalezId = await ensureUser("Gonzalez");

// --- 4. Resolve known users + apply overrides on cage ---
async function userIdByEmail(email: string): Promise<string> {
  const [u] = await db.select().from(schema.users).where(eq(schema.users.email, email));
  if (!u) throw new Error(`Missing expected user ${email}`);
  return u.id;
}

const overrides: Array<{ coachId: string; label: string; cents: number }> = [
  { coachId: await userIdByEmail("historical-c-fry@imported.local"), label: "C. Fry", cents: 1700 },
  { coachId: await userIdByEmail("historical-jose-iniguez@imported.local"), label: "Jose Iniguez", cents: 1700 },
  { coachId: gomezId, label: "Gomez", cents: 1700 },
  { coachId: await userIdByEmail("historical-cole-parker@imported.local"), label: "Cole Parker", cents: 1700 },
  { coachId: sanchezId, label: "Sanchez", cents: 1700 },
  { coachId: await userIdByEmail("historical-jamie-leon@imported.local"), label: "Jamie Leon", cents: 1700 },
  { coachId: await userIdByEmail("historical-david-lusk@imported.local"), label: "David Lusk", cents: 1500 },
  { coachId: gonzalezId, label: "Gonzalez", cents: 1000 },
];

for (const ov of overrides) {
  const [existing] = await db
    .select()
    .from(schema.coachRateOverrides)
    .where(
      and(
        eq(schema.coachRateOverrides.coachId, ov.coachId),
        eq(schema.coachRateOverrides.resourceType, "cage"),
      ),
    );
  if (existing) {
    if (existing.ratePer30MinCents === ov.cents) {
      console.log(`Override unchanged: ${ov.label.padEnd(14)} cage $${(ov.cents / 100).toFixed(2)}`);
      continue;
    }
    console.log(`Updating override: ${ov.label.padEnd(14)} cage $${(existing.ratePer30MinCents / 100).toFixed(2)} -> $${(ov.cents / 100).toFixed(2)}`);
    await db
      .update(schema.coachRateOverrides)
      .set({ ratePer30MinCents: ov.cents, updatedAt: new Date() })
      .where(
        and(
          eq(schema.coachRateOverrides.coachId, ov.coachId),
          eq(schema.coachRateOverrides.resourceType, "cage"),
        ),
      );
    await db.insert(schema.auditLog).values({
      actorUserId: actor.id,
      entityType: "rate_override",
      entityId: `${ov.coachId}:cage`,
      action: "update",
      diff: { before: { ratePer30MinCents: existing.ratePer30MinCents }, after: { ratePer30MinCents: ov.cents } },
    });
  } else {
    console.log(`Inserting override: ${ov.label.padEnd(14)} cage $${(ov.cents / 100).toFixed(2)}`);
    await db.insert(schema.coachRateOverrides).values({
      coachId: ov.coachId,
      resourceType: "cage",
      ratePer30MinCents: ov.cents,
    });
    await db.insert(schema.auditLog).values({
      actorUserId: actor.id,
      entityType: "rate_override",
      entityId: `${ov.coachId}:cage`,
      action: "create",
      diff: { after: { coachId: ov.coachId, resourceType: "cage", ratePer30MinCents: ov.cents } },
    });
  }
}

console.log("\nDone.");
