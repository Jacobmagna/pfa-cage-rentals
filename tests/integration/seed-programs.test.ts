// Integration proof for src/db/seed-programs.ts against the Neon DEV
// branch (ep-dawn-forest, via INTEGRATION_DATABASE_URL — see setup.ts).
//
// What it proves:
//   1. First seedPrograms(db) leaves all 9 PROGRAM_NAMES present in the
//      table (whether it inserted them fresh or they already existed).
//   2. A 2nd run inserts 0 (onConflictDoNothing on the unique name) and
//      never creates duplicates.
//
// Cleanup: delete exactly the 9 seeded program rows in afterAll so the
// branch is left as we found it.

import { afterAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { programs } from "@/db/schema";
import { PROGRAM_NAMES, seedPrograms } from "@/db/seed-programs";

const describeIf = process.env.INTEGRATION_DATABASE_URL
  ? describe
  : describe.skip;

afterAll(async () => {
  await db.delete(programs).where(inArray(programs.name, [...PROGRAM_NAMES]));
});

describeIf("seedPrograms (integration, dev branch)", () => {
  it("seeds all 9 programs and is idempotent on a 2nd run", async () => {
    // --- first run: all 9 should be present afterwards --------------
    const first = await seedPrograms(db);
    expect(first.inserted + first.skipped).toBe(PROGRAM_NAMES.length);

    const afterFirst = await db
      .select({ name: programs.name })
      .from(programs)
      .where(inArray(programs.name, [...PROGRAM_NAMES]));
    const namesAfterFirst = new Set(afterFirst.map((r) => r.name));
    for (const name of PROGRAM_NAMES) {
      expect(namesAfterFirst.has(name), `program present: ${name}`).toBe(true);
    }
    expect(afterFirst.length).toBe(PROGRAM_NAMES.length);

    // --- second run: inserts 0, no duplicates -----------------------
    const second = await seedPrograms(db);
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(PROGRAM_NAMES.length);

    const afterSecond = await db
      .select({ id: programs.id })
      .from(programs)
      .where(inArray(programs.name, [...PROGRAM_NAMES]));
    expect(afterSecond.length).toBe(PROGRAM_NAMES.length);
  });
});
