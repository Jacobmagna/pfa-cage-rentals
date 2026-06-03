// Integration proof for src/db/seed-athletes.ts against the Neon DEV
// branch (ep-dawn-forest, via INTEGRATION_DATABASE_URL — see setup.ts).
// This is the ONLY place seedAthletes is exercised against a real DB by
// the worker; the Orchestrator runs `npm run db:seed` against dev then
// prod with the real (gitignored) roster JSON.
//
// Deliberately does NOT depend on build/seed-data/athletes.json (PII,
// gitignored). Instead it builds an in-test FIXTURE that exercises the
// name shapes in the real roster — plain "First Last", a multi-word last
// name, a suffix, a parenthetical-nickname first name, and a null
// birthday — so we prove seedAthletes preserves whatever firstName /
// lastName / term / birthday split the parser produced (the seeder does
// NOT re-parse names; it stores them verbatim).
//
// What it proves:
//   1. First seedAthletes(fixture) inserts ALL rows (inserted === N,
//      skipped === 0) and the rows round-trip with the exact values.
//   2. Second seedAthletes(fixture) is idempotent on the natural key
//      (firstName, lastName, birthday): inserted === 0, skipped === N,
//      and no duplicates exist (count by our keys is still N).
//   3. loadAthletesFromJson on a missing path returns [].
//
// A unique lastName suffix per run keeps the natural-key dedupe
// deterministic across concurrent/re-run scenarios and lets afterAll
// delete exactly the rows we created.

import { afterAll, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { db } from "@/db";
import { athletes } from "@/db/schema";
import {
  loadAthletesFromJson,
  seedAthletes,
  type AthleteSeedInput,
} from "@/db/seed-athletes";

const describeIf = process.env.INTEGRATION_DATABASE_URL
  ? describe
  : describe.skip;

// Unique per run. Appended to every fixture lastName so our rows are
// isolated from any other roster data on the branch and trivially
// cleanable.
const SUFFIX = `_seedtest_${Date.now()}_${Math.random()
  .toString(36)
  .slice(2, 8)}`;

const TERM = "Summer 2026";

// Fixture rows exercising the real roster's name shapes. lastName carries
// the unique SUFFIX so dedupe + cleanup are deterministic.
const FIXTURE: AthleteSeedInput[] = [
  // plain "First Last"
  { firstName: "Diego", lastName: `Ramirez${SUFFIX}`, birthday: "2011-03-14", term: TERM },
  // lastName containing a middle name
  { firstName: "Marco", lastName: `Vicente Milazzo${SUFFIX}`, birthday: "2010-07-22", term: TERM },
  // suffix in the last name
  { firstName: "Carlos", lastName: `Gutierrez Jr.${SUFFIX}`, birthday: "2012-01-09", term: TERM },
  // parenthetical-nickname first name
  { firstName: "Julian (JJ)", lastName: `DiBianca${SUFFIX}`, birthday: "2011-11-30", term: TERM },
  // null birthday
  { firstName: "Sam", lastName: `Nobirthday${SUFFIX}`, birthday: null, term: TERM },
];

afterAll(async () => {
  // Remove exactly the rows this suite created (every fixture lastName
  // ends with the unique SUFFIX). like-escape isn't needed: SUFFIX is
  // alphanumeric/underscore, and underscore as a LIKE wildcard only
  // widens the match — still scoped to our test rows.
  await db.delete(athletes).where(like(athletes.lastName, `%${SUFFIX}`));
});

describeIf("seedAthletes (integration, dev branch)", () => {
  it("inserts all fixture rows on first run, then is idempotent on the natural key", async () => {
    // --- first run: everything is new --------------------------------
    const first = await seedAthletes(db, FIXTURE);
    expect(first.inserted).toBe(FIXTURE.length);
    expect(first.skipped).toBe(0);

    // Each row round-trips with the exact values we gave.
    for (const f of FIXTURE) {
      const found = await db
        .select({
          firstName: athletes.firstName,
          lastName: athletes.lastName,
          birthday: athletes.birthday,
          term: athletes.term,
          archivedAt: athletes.archivedAt,
        })
        .from(athletes)
        .where(
          and(
            eq(athletes.firstName, f.firstName),
            eq(athletes.lastName, f.lastName),
          ),
        );
      expect(found.length, `one row for ${f.lastName}`).toBe(1);
      expect(found[0].firstName).toBe(f.firstName);
      expect(found[0].lastName).toBe(f.lastName);
      expect(found[0].birthday).toBe(f.birthday);
      expect(found[0].term).toBe(f.term);
      expect(found[0].archivedAt).toBeNull();
    }

    // --- second run: idempotent on (firstName, lastName, birthday) ----
    const second = await seedAthletes(db, FIXTURE);
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(FIXTURE.length);

    // No duplicates: the count of our rows is still exactly N.
    const ours = await db
      .select({ id: athletes.id })
      .from(athletes)
      .where(like(athletes.lastName, `%${SUFFIX}`));
    expect(ours.length).toBe(FIXTURE.length);
  });

  it("loadAthletesFromJson returns [] when the file is absent", () => {
    expect(loadAthletesFromJson("does/not/exist.json")).toEqual([]);
  });
});
