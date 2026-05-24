// Seeds PFA's physical inventory. Idempotent: every row uses
// `onConflictDoNothing` against the unique `name` column so the
// script is safe to rerun (Vercel deploys, fresh local dev DBs,
// etc.). Existing rows are never overwritten — if Dad renames
// "Cage 1" through the admin UI later, the seed won't clobber it.
//
// Sort order is contiguous (1–10) by section: cages first, then
// bullpens, then weight rooms. Schedule grid + dropdowns render in
// this order without extra logic. Gaps would let us insert "Cage 6"
// at sortOrder 5.5 later, but YAGNI for now.
//
// Resource counts come from BRAINSTORM.md and were confirmed with
// Dad on 2026-05-24: 5 cages, 2 bullpens, 3 weight room slots.
// The hitting/pitching distinction is per-session (chosen by the
// coach when logging), not a resource attribute.

import { db } from "./index";
import { resources, type NewResource } from "./schema";

const SEED_RESOURCES: NewResource[] = [
  { name: "Cage 1", type: "cage", sortOrder: 1 },
  { name: "Cage 2", type: "cage", sortOrder: 2 },
  { name: "Cage 3", type: "cage", sortOrder: 3 },
  { name: "Cage 4", type: "cage", sortOrder: 4 },
  { name: "Cage 5", type: "cage", sortOrder: 5 },
  { name: "Bullpen 1", type: "bullpen", sortOrder: 6 },
  { name: "Bullpen 2", type: "bullpen", sortOrder: 7 },
  { name: "Weight Room 1", type: "weight_room", sortOrder: 8 },
  { name: "Weight Room 2", type: "weight_room", sortOrder: 9 },
  { name: "Weight Room 3", type: "weight_room", sortOrder: 10 },
];

export async function seedResources(): Promise<void> {
  const inserted = await db
    .insert(resources)
    .values(SEED_RESOURCES)
    .onConflictDoNothing({ target: resources.name })
    .returning({ id: resources.id, name: resources.name });

  if (inserted.length === 0) {
    console.log("[seed] resources: all 10 rows already present, nothing to insert");
    return;
  }
  console.log(`[seed] resources: inserted ${inserted.length} row(s):`);
  for (const row of inserted) {
    console.log(`  + ${row.name}`);
  }
}
