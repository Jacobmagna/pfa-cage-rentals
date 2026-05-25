import { config } from "dotenv";
config({ path: ".env.local" });
const { neon } = await import("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL!);

const wanted = ["Fry", "Iniguez", "Gomez", "Parker", "Sanchez", "Leon", "Lusk", "Gonzalez"];

for (const w of wanted) {
  const rows = await sql`
    SELECT id, name, email, role, deleted_at IS NULL AS active
    FROM users
    WHERE name ILIKE ${"%" + w + "%"}
    ORDER BY name
  `;
  console.log(`\n=== ${w} ===`);
  for (const r of rows) {
    console.log(`  ${r.id}  ${r.name?.padEnd(30)} ${r.email?.padEnd(40)} role=${r.role} active=${r.active}`);
  }
}

console.log("\n=== Existing overrides ===");
const ov = await sql`
  SELECT coach_id, u.name, u.email, resource_type, rate_per_30_min_cents
  FROM coach_rate_overrides o LEFT JOIN users u ON u.id=o.coach_id
`;
for (const o of ov) {
  console.log(`  ${o.name?.padEnd(30)} ${o.resource_type.padEnd(12)} $${(o.rate_per_30_min_cents/100).toFixed(2)}  (coach=${o.coach_id})`);
}
