// Seeds PFA's training programs — FEAT-12 pass 2.
//
// The 9 program names are NOT PII, so they live as a committed constant
// (unlike the gitignored coach/athlete rosters). Idempotent via
// `onConflictDoNothing` on the unique `programs.name` column, mirroring
// seed-resources.ts — safe to rerun on every deploy / fresh DB.
//
// cap, capPeriod, and defaultRatePer30MinCents are all left NULL: a
// program with no rate resolves to $0 pay until an admin sets one in the
// Programs UI (QA2-9b). `active` defaults to true at the DB layer.
//
// NO top-level side effects: importing this module must not connect to a
// DB. The orchestrator (seed.ts) passes in the db handle after dotenv
// loads. Does NOT print — the orchestrator owns logging.

import { programs, type NewProgram } from "./schema";
import type { db as Database } from "./index";

// The 9 programs, in the exact order confirmed for FEAT-12 pass 2.
export const PROGRAM_NAMES = [
  "HS Summer Program",
  "HS Summer Program-Throwing",
  "HS Summer Program-Catching",
  "HS Summer Program-Hitting",
  "Youth Summer Camp",
  "HS Summer Softball Front Desk",
  "Cleaning",
  "HS Summer Travel Team",
  "HS Summer Travel Game",
] as const;

// Idempotent bulk insert of the 9 programs (name only; cap/capPeriod/rate
// left NULL). `onConflictDoNothing` on the unique name means a rerun
// inserts 0 and never clobbers an admin's later edits. Returns
// { inserted, skipped }.
export async function seedPrograms(
  db: typeof Database,
): Promise<{ inserted: number; skipped: number }> {
  const values: NewProgram[] = PROGRAM_NAMES.map((name) => ({ name }));

  const inserted = await db
    .insert(programs)
    .values(values)
    .onConflictDoNothing({ target: programs.name })
    .returning({ id: programs.id });

  return {
    inserted: inserted.length,
    skipped: PROGRAM_NAMES.length - inserted.length,
  };
}
