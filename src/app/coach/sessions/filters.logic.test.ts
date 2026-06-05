import { describe, expect, it } from "vitest";
import {
  buildHistoryQuery,
  parseHistoryFilters,
} from "./filters.logic";

// Locks the pure filter parsing + the pagination query-string builder for the
// coach "My sessions" page. The builder must (a) omit empty/blank params,
// (b) round-trip all four filters plus the page, and (c) keep page 1 out of
// the URL. The parser must validate dates, drop unknown resource ids, and
// reject junk use-types — so a hand-edited URL can't break the WHERE clause.

const VALID_RESOURCES = new Set(["r1", "r2", "r3"]);

describe("buildHistoryQuery", () => {
  it("returns the bare path when no params are present", () => {
    expect(buildHistoryQuery({})).toBe("/coach/sessions");
    expect(buildHistoryQuery({ page: 1 })).toBe("/coach/sessions");
    expect(
      buildHistoryQuery({ from: "", to: null, resourceId: undefined }),
    ).toBe("/coach/sessions");
  });

  it("omits page 1 (and any page <= 1) but includes page > 1", () => {
    expect(buildHistoryQuery({ page: 1 })).toBe("/coach/sessions");
    expect(buildHistoryQuery({ page: 2 })).toBe("/coach/sessions?page=2");
  });

  it("round-trips all four filters plus the page in stable order", () => {
    expect(
      buildHistoryQuery({
        from: "2026-05-01",
        to: "2026-05-31",
        resourceId: "r2",
        useType: "hitting",
        page: 3,
      }),
    ).toBe(
      "/coach/sessions?from=2026-05-01&to=2026-05-31&resourceId=r2&useType=hitting&page=3",
    );
  });

  it("preserves filters when paging without a page-1 entry", () => {
    expect(
      buildHistoryQuery({
        from: "2026-05-01",
        resourceId: "r1",
      }),
    ).toBe("/coach/sessions?from=2026-05-01&resourceId=r1");
  });
});

describe("parseHistoryFilters", () => {
  it("defaults to all sessions (no filters) when params are empty", () => {
    const f = parseHistoryFilters({}, VALID_RESOURCES);
    expect(f).toEqual({
      from: null,
      to: null,
      resourceId: null,
      useType: null,
      isFiltered: false,
    });
  });

  it("accepts valid ISO dates and a known resource + use-type", () => {
    const f = parseHistoryFilters(
      {
        from: "2026-05-01",
        to: "2026-05-31",
        resourceId: "r2",
        useType: "pitching",
      },
      VALID_RESOURCES,
    );
    expect(f).toEqual({
      from: "2026-05-01",
      to: "2026-05-31",
      resourceId: "r2",
      useType: "pitching",
      isFiltered: true,
    });
  });

  it("drops malformed dates, unknown resources, and junk use-types", () => {
    const f = parseHistoryFilters(
      {
        from: "05/01/2026",
        to: "not-a-date",
        resourceId: "r-unknown",
        useType: "weightlifting",
      },
      VALID_RESOURCES,
    );
    expect(f).toEqual({
      from: null,
      to: null,
      resourceId: null,
      useType: null,
      isFiltered: false,
    });
  });

  it("flags isFiltered when only one filter is active", () => {
    expect(
      parseHistoryFilters({ useType: "hitting" }, VALID_RESOURCES).isFiltered,
    ).toBe(true);
    expect(
      parseHistoryFilters({ resourceId: "r3" }, VALID_RESOURCES).isFiltered,
    ).toBe(true);
    expect(
      parseHistoryFilters({ from: "2026-01-01" }, VALID_RESOURCES).isFiltered,
    ).toBe(true);
  });

  it("picks the first value when a param arrives as an array", () => {
    const f = parseHistoryFilters(
      { resourceId: ["r1", "r2"], useType: ["hitting", "pitching"] },
      VALID_RESOURCES,
    );
    expect(f.resourceId).toBe("r1");
    expect(f.useType).toBe("hitting");
  });
});
