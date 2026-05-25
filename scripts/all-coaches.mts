import { config } from "dotenv";
config({ path: ".env.local" });
const { neon } = await import("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL!);

// All coaches with > 0 sessions in the DB, with session counts
const rows = await sql`
  SELECT u.id, u.name, u.email, COUNT(sb.id)::int as session_count
  FROM users u
  LEFT JOIN sessions_billing sb ON sb.coach_id = u.id
  WHERE u.role = 'coach' AND u.deleted_at IS NULL
  GROUP BY u.id
  ORDER BY u.name
`;
console.log(`coaches: ${rows.length}`);
for (const r of rows) {
  console.log(`  ${(r.name ?? "???").padEnd(34)} ${(r.email ?? "???").padEnd(45)} sessions=${r.session_count}`);
}
