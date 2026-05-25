import { config } from "dotenv";
config({ path: ".env.local" });
const { neon } = await import("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL!);
const r = await sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 5`;
console.log(r);
const cols = await sql`SELECT column_name, data_type, column_default FROM information_schema.columns WHERE table_name='sessions_billing' ORDER BY ordinal_position`;
console.log("\nsessions_billing columns:");
for (const c of cols) console.log(" ", c.column_name, c.data_type, c.column_default);
