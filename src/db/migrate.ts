import { config } from "dotenv";
config({ path: ".env.local" });

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { neon } from "@neondatabase/serverless";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL not set");

async function main() {
  const sql = neon(DATABASE_URL!);
  const dir = "drizzle";
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const path = join(dir, file);
    const raw = readFileSync(path, "utf8");
    const statements = raw
      .split(/-->\s*statement-breakpoint/)
      .map((s) => s.trim())
      .filter(Boolean);

    console.log(`Applying ${file} (${statements.length} statements)`);
    for (const stmt of statements) {
      await sql.query(stmt);
    }
  }

  console.log("Migrations applied.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
