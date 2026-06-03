// Importable, side-effect-free data-clear logic.
//
// Wipes all scheduled / transactional / seeded data (the DELETE_ORDER
// tables) while KEEPING coaches, auth, cage inventory, rates, and org
// settings (the KEEP_TABLES). The DELETE/KEEP sets and the delete order
// are LOCKED by Jacob — do not change them here.
//
// Neon HTTP driver = NO transactions, so the deletes are issued as
// sequential statements and the ORDER MATTERS: children before parents,
// never relying on cascade so the row counts stay explicit. See the
// rationale in src/db/schema.ts (hour_logs / attendance_sessions /
// program_schedule_blocks FK → programs with NO cascade, so they MUST
// be deleted before programs).
//
// This module has NO top-level side effects: importing it neither
// connects to nor mutates any database. The caller (clear-data-cli.ts
// or the integration test) supplies the `db` handle.

import { sql } from "drizzle-orm";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";

// FK-safe delete order: delete children before parents. Index = step.
export const DELETE_ORDER = [
  "attendance_records",
  "attendance_sessions",
  "program_schedule_blocks",
  "program_schedule_series",
  "hour_logs",
  "sessions_billing",
  "blocked_times",
  "program_rate_overrides",
  "athlete_programs",
  "coach_programs",
  "athletes",
  "programs",
  "coach_payments",
  "audit_log",
] as const;

// Tables that MUST remain untouched by clearData.
export const KEEP_TABLES = [
  "users",
  "accounts",
  "sessions",
  "verification_tokens",
  "resources",
  "rate_defaults",
  "coach_rate_overrides",
  "org_settings",
] as const;

export type DeleteTable = (typeof DELETE_ORDER)[number];
export type KeepTable = (typeof KEEP_TABLES)[number];

// Allow-list of every table this module is permitted to touch. Built
// from the two LOCKED sets so no arbitrary identifier can ever be
// interpolated into SQL — countRows refuses anything not in here.
const ALLOWED_TABLES: ReadonlySet<string> = new Set<string>([
  ...DELETE_ORDER,
  ...KEEP_TABLES,
]);

// Drizzle's neon-http db handle. Generic over schema so any caller's
// typed db is accepted.
type Db = NeonHttpDatabase<Record<string, unknown>>;

// SELECT count(*) for a single table. The table name is validated
// against the allow-list and only then used to build a quoted SQL
// identifier — never a raw string interpolation — so this is not an
// injection vector even though the value is dynamic.
export async function countRows(db: Db, table: string): Promise<number> {
  if (!ALLOWED_TABLES.has(table)) {
    throw new Error(`countRows: refusing to count non-allow-listed table "${table}"`);
  }
  const result = await db.execute<{ count: number | string }>(
    sql`SELECT count(*) AS count FROM ${sql.identifier(table)}`,
  );
  const row = result.rows[0];
  // count(*) comes back as a bigint → string under node-postgres-style
  // drivers, number under others. Normalize either way.
  return Number(row?.count ?? 0);
}

// Wipes the DELETE_ORDER tables (sequentially, no transaction) and
// returns the before/after row counts for EVERY table (delete + keep).
// Does NOT print — the caller is responsible for logging.
export async function clearData(
  db: Db,
): Promise<{ before: Record<string, number>; after: Record<string, number> }> {
  const allTables = [...DELETE_ORDER, ...KEEP_TABLES];

  const before: Record<string, number> = {};
  for (const table of allTables) {
    before[table] = await countRows(db, table);
  }

  // Sequential deletes in FK-safe order. The identifier is one of the
  // LOCKED DELETE_ORDER constants, quoted via sql.identifier.
  for (const table of DELETE_ORDER) {
    await db.execute(sql`DELETE FROM ${sql.identifier(table)}`);
  }

  const after: Record<string, number> = {};
  for (const table of allTables) {
    after[table] = await countRows(db, table);
  }

  return { before, after };
}
