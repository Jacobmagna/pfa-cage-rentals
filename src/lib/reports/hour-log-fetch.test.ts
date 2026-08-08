// SQL-shape tests for the widened coach filter (reports-tabs SPEC Phase A).
//
// These never touch a database: drizzle's `.toSQL()` compiles the query
// without executing it, so we can assert the exact predicate the widened
// `coachIds: string[]` produces. The case that matters most is the EMPTY
// one — it must emit NO coach predicate at all. An `IN ()` is invalid SQL,
// and some drivers degrade it to "matches nothing", which would silently
// empty the needs-review queue (needs-review.ts passes coachIds: []).
//
// `hour-log-fetch.ts` imports `@/db`, which throws at module load if
// DATABASE_URL is unset — so we stub it before importing, the same way
// needs-review.test.ts does. No connection is ever opened.

import { beforeAll, describe, expect, it } from "vitest";
import type { NormalizedHourLogFilters } from "./hour-log-filters";

type Compiled = { sql: string; params: unknown[] };
let compile: (filters: NormalizedHourLogFilters) => Compiled;

beforeAll(async () => {
  process.env.DATABASE_URL ??= "postgresql://user:pass@localhost.tld/testdb";
  const [{ hourLogRowConditions }, { db }, { hourLogs }, { and }] =
    await Promise.all([
      import("./hour-log-fetch"),
      import("@/db"),
      import("@/db/schema"),
      import("drizzle-orm"),
    ]);
  compile = (filters) =>
    db
      .select({ id: hourLogs.id })
      .from(hourLogs)
      .where(and(...hourLogRowConditions(filters)))
      .toSQL() as Compiled;
});

function filters(
  overrides: Partial<NormalizedHourLogFilters> = {},
): NormalizedHourLogFilters {
  return {
    from: "2026-03-01",
    to: "2026-03-31",
    fromDate: new Date("2026-03-01T08:00:00.000Z"),
    toDateExclusive: new Date("2026-04-01T07:00:00.000Z"),
    coachIds: [],
    programId: undefined,
    isFiltered: false,
    ...overrides,
  };
}

describe("hourLogRowConditions — coach predicate", () => {
  it("EMPTY coachIds emits NO coach predicate (all coaches)", () => {
    const { sql, params } = compile(filters({ coachIds: [] }));
    expect(sql).not.toContain("coach_id");
    // Only the status IN-list params plus the two date bounds remain
    // (drizzle serialises the timestamp bounds before binding).
    expect(params).toHaveLength(4);
    expect(params.slice(0, 2)).toEqual(["posted", "rejected"]);
  });

  it("EMPTY coachIds never emits a degenerate IN ()", () => {
    const { sql } = compile(filters({ coachIds: [] }));
    expect(sql).not.toMatch(/in\s*\(\s*\)/i);
  });

  it("one coach emits a single-element IN over coach_id", () => {
    const { sql, params } = compile(filters({ coachIds: ["coach-1"] }));
    expect(sql).toContain("coach_id");
    expect(params).toContain("coach-1");
  });

  it("several coaches emit one placeholder per id, in order", () => {
    const { sql, params } = compile(
      filters({ coachIds: ["coach-1", "coach-2", "coach-3"] }),
    );
    expect(sql).toContain("coach_id");
    expect(params.slice(-3)).toEqual(["coach-1", "coach-2", "coach-3"]);
  });

  it("the program predicate is unaffected by the coach widening", () => {
    const withProgram = compile(filters({ programId: "prog-1" }));
    expect(withProgram.sql).toContain("program_id");
    expect(withProgram.params).toContain("prog-1");
    expect(compile(filters()).sql).not.toContain("program_id");
  });

  it("held logs stay excluded regardless of the coach filter", () => {
    for (const coachIds of [[], ["coach-1"], ["coach-1", "coach-2"]]) {
      const { params } = compile(filters({ coachIds }));
      expect(params).toContain("posted");
      expect(params).toContain("rejected");
      expect(params).not.toContain("held");
    }
  });
});
