// Unit tests for the WIDENED hour-log coach filter (reports-tabs SPEC
// Phase A). `coachId?: string` became `coachIds: string[]` so the work-log
// filter shape matches the cage-side one in lib/reports/filters.ts.
//
// Two contracts are locked down here:
//   1. Empty array is the "no coach filter" sentinel — the SAME convention
//      the cage side uses. `isFiltered` must not be tripped by it.
//   2. URL back-compat: the canonical query key is `coachIds`, but the
//      legacy single `coachId` key is still read and merged, so a bookmark
//      or an in-app deep link (/admin/hour-log?coachId=<id>) filters
//      exactly as it did before the widening.

import { describe, expect, it } from "vitest";
import {
  hourLogFiltersFromURLSearchParams,
  hourLogFiltersToQueryString,
  normalizeHourLogFilters,
} from "./hour-log-filters";

describe("normalizeHourLogFilters — coach set", () => {
  it("no coach params → empty array (include everyone)", () => {
    expect(normalizeHourLogFilters({}).coachIds).toEqual([]);
  });

  it("one coach via the canonical coachIds key", () => {
    expect(normalizeHourLogFilters({ coachIds: "c1" }).coachIds).toEqual([
      "c1",
    ]);
  });

  it("several coaches via a repeated coachIds key", () => {
    expect(
      normalizeHourLogFilters({ coachIds: ["c1", "c2", "c3"] }).coachIds,
    ).toEqual(["c1", "c2", "c3"]);
  });

  it("preserves the submitted order", () => {
    expect(
      normalizeHourLogFilters({ coachIds: ["c3", "c1", "c2"] }).coachIds,
    ).toEqual(["c3", "c1", "c2"]);
  });

  it("de-dupes repeated ids", () => {
    expect(
      normalizeHourLogFilters({ coachIds: ["c1", "c2", "c1"] }).coachIds,
    ).toEqual(["c1", "c2"]);
  });
});

describe("normalizeHourLogFilters — malformed coach input", () => {
  it("empty string → no filter (the 'All coaches' option submits '')", () => {
    expect(normalizeHourLogFilters({ coachIds: "" }).coachIds).toEqual([]);
  });

  it("whitespace-only → no filter (matches the pre-widening trim)", () => {
    expect(normalizeHourLogFilters({ coachIds: "   " }).coachIds).toEqual([]);
  });

  it("trims surrounding whitespace off real ids", () => {
    expect(normalizeHourLogFilters({ coachIds: "  c1 " }).coachIds).toEqual([
      "c1",
    ]);
  });

  it("drops empty/blank entries from a mixed array", () => {
    expect(
      normalizeHourLogFilters({ coachIds: ["", "c1", "  ", "c2"] }).coachIds,
    ).toEqual(["c1", "c2"]);
  });

  it("an array of only blanks → no filter", () => {
    expect(normalizeHourLogFilters({ coachIds: ["", "  "] }).coachIds).toEqual(
      [],
    );
  });

  it("explicit undefined → no filter", () => {
    expect(
      normalizeHourLogFilters({ coachIds: undefined, coachId: undefined })
        .coachIds,
    ).toEqual([]);
  });
});

describe("normalizeHourLogFilters — legacy coachId back-compat", () => {
  it("legacy single coachId still filters (old bookmark)", () => {
    expect(normalizeHourLogFilters({ coachId: "c1" }).coachIds).toEqual(["c1"]);
  });

  it("legacy coachId still trims to 'no filter' when blank", () => {
    expect(normalizeHourLogFilters({ coachId: "  " }).coachIds).toEqual([]);
  });

  it("a repeated legacy coachId key is read as a set", () => {
    expect(normalizeHourLogFilters({ coachId: ["c1", "c2"] }).coachIds).toEqual(
      ["c1", "c2"],
    );
  });

  it("merges both keys, canonical first, de-duped", () => {
    expect(
      normalizeHourLogFilters({ coachIds: ["c1"], coachId: ["c2", "c1"] })
        .coachIds,
    ).toEqual(["c1", "c2"]);
  });

  it("legacy-only id produces the SAME filter as the canonical key", () => {
    const legacy = normalizeHourLogFilters({ coachId: "c9" });
    const canonical = normalizeHourLogFilters({ coachIds: "c9" });
    expect(legacy.coachIds).toEqual(canonical.coachIds);
    expect(legacy.isFiltered).toBe(canonical.isFiltered);
  });
});

describe("normalizeHourLogFilters — isFiltered", () => {
  it("default load (no params) is NOT filtered", () => {
    expect(normalizeHourLogFilters({}).isFiltered).toBe(false);
  });

  it("an empty coach set does NOT count as a filter", () => {
    expect(normalizeHourLogFilters({ coachIds: [] }).isFiltered).toBe(false);
    expect(normalizeHourLogFilters({ coachIds: ["", "  "] }).isFiltered).toBe(
      false,
    );
  });

  it("one coach counts as filtered", () => {
    expect(normalizeHourLogFilters({ coachIds: "c1" }).isFiltered).toBe(true);
  });

  it("several coaches count as filtered", () => {
    expect(
      normalizeHourLogFilters({ coachIds: ["c1", "c2"] }).isFiltered,
    ).toBe(true);
  });

  it("a legacy coachId counts as filtered", () => {
    expect(normalizeHourLogFilters({ coachId: "c1" }).isFiltered).toBe(true);
  });

  it("a program filter alone still counts as filtered", () => {
    expect(normalizeHourLogFilters({ programId: "p1" }).isFiltered).toBe(true);
  });

  it("a narrowed date range alone still counts as filtered", () => {
    expect(
      normalizeHourLogFilters({ from: "2020-01-01", to: "2020-01-31" })
        .isFiltered,
    ).toBe(true);
  });
});

describe("hourLogFiltersFromURLSearchParams", () => {
  it("reads a repeated coachIds key", () => {
    const sp = new URLSearchParams("coachIds=c1&coachIds=c2");
    expect(hourLogFiltersFromURLSearchParams(sp).coachIds).toEqual([
      "c1",
      "c2",
    ]);
  });

  it("reads the LEGACY coachId key (shared/bookmarked link)", () => {
    const sp = new URLSearchParams("coachId=c1");
    expect(hourLogFiltersFromURLSearchParams(sp).coachIds).toEqual(["c1"]);
  });

  it("a legacy link resolves identically to the canonical one", () => {
    const legacy = hourLogFiltersFromURLSearchParams(
      new URLSearchParams("from=2026-01-01&to=2026-01-31&coachId=c1"),
    );
    const canonical = hourLogFiltersFromURLSearchParams(
      new URLSearchParams("from=2026-01-01&to=2026-01-31&coachIds=c1"),
    );
    expect(legacy).toEqual(canonical);
  });

  it("no coach key at all → empty array", () => {
    const sp = new URLSearchParams("from=2026-01-01&to=2026-01-31");
    expect(hourLogFiltersFromURLSearchParams(sp).coachIds).toEqual([]);
  });

  it("merges legacy + canonical when a link carries both", () => {
    const sp = new URLSearchParams("coachIds=c1&coachId=c2");
    expect(hourLogFiltersFromURLSearchParams(sp).coachIds).toEqual([
      "c1",
      "c2",
    ]);
  });
});

describe("hourLogFiltersToQueryString — round trip", () => {
  it("emits the canonical coachIds key, once per coach", () => {
    const f = normalizeHourLogFilters({ coachIds: ["c1", "c2"] });
    const sp = new URLSearchParams(hourLogFiltersToQueryString(f));
    expect(sp.getAll("coachIds")).toEqual(["c1", "c2"]);
    expect(sp.get("coachId")).toBeNull();
  });

  it("omits the coach key entirely when no coach is selected", () => {
    const f = normalizeHourLogFilters({});
    const sp = new URLSearchParams(hourLogFiltersToQueryString(f));
    expect(sp.getAll("coachIds")).toEqual([]);
    expect(sp.has("coachIds")).toBe(false);
  });

  it("round-trips a multi-coach filter unchanged", () => {
    const f = normalizeHourLogFilters({
      from: "2026-03-01",
      to: "2026-03-31",
      coachIds: ["c1", "c2"],
      programId: "p1",
    });
    const back = hourLogFiltersFromURLSearchParams(
      new URLSearchParams(hourLogFiltersToQueryString(f)),
    );
    expect(back).toEqual(f);
  });

  it("round-trips a LEGACY single-coach link into the canonical form", () => {
    const f = normalizeHourLogFilters({
      from: "2026-03-01",
      to: "2026-03-31",
      coachId: "c1",
    });
    const back = hourLogFiltersFromURLSearchParams(
      new URLSearchParams(hourLogFiltersToQueryString(f)),
    );
    expect(back).toEqual(f);
    expect(back.coachIds).toEqual(["c1"]);
  });
});
