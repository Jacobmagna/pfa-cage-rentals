// Unit tests for the pure filter parsing.
//
// This file used to lock down the QA4 "scope" checkboxes (cage/program)
// and their `scopeApplied` GET-form marker. Those checkboxes are GONE —
// the reports sub-tabs replaced them (reports-tabs SPEC §4), which is
// what removes the silent-override defect in SPEC §1(b). What matters
// now is the inverse property: the retired scope params must be
// completely INERT, so a bookmarked or shared URL still carrying them
// cannot narrow anybody's report.

import { describe, expect, it } from "vitest";
import {
  filtersFromURLSearchParams,
  filtersToQueryString,
  normalizeFilters,
} from "./filters";

describe("normalizeFilters — retired scope params are inert", () => {
  it("ignores a legacy scopeApplied marker with no boxes", () => {
    // The old semantics: marker present + neither box = BOTH categories
    // off, i.e. an empty report. That must no longer be expressible.
    const f = normalizeFilters({
      scopeApplied: "1",
    } as Parameters<typeof normalizeFilters>[0]);
    expect(f).not.toHaveProperty("includeCageSessions");
    expect(f).not.toHaveProperty("includeProgramHours");
  });

  it("a legacy scope URL normalizes identically to a bare one", () => {
    const legacy = filtersFromURLSearchParams(
      new URLSearchParams(
        "from=2026-08-01&to=2026-08-31&scopeApplied=1&includeCage=1",
      ),
    );
    const bare = filtersFromURLSearchParams(
      new URLSearchParams("from=2026-08-01&to=2026-08-31"),
    );
    expect(legacy).toEqual(bare);
  });

  it("a legacy work-hours-off URL no longer suppresses anything", () => {
    // ?scopeApplied=1&includeCage=1 previously meant "work hours OFF".
    // The filter object it produces must be indistinguishable from the
    // default, so the fetch returns work hours regardless.
    const f = filtersFromURLSearchParams(
      new URLSearchParams("scopeApplied=1&includeCage=1"),
    );
    expect(f).toEqual(normalizeFilters({}));
  });
});

describe("filtersToQueryString — emits only real filters", () => {
  it("emits no scope keys", () => {
    const sp = new URLSearchParams(filtersToQueryString(normalizeFilters({})));
    expect(sp.has("scopeApplied")).toBe(false);
    expect(sp.has("includeCage")).toBe(false);
    expect(sp.has("includeProgram")).toBe(false);
  });

  it("emits NO tab — a download must never inherit the open tab", () => {
    const sp = new URLSearchParams(
      filtersToQueryString(
        normalizeFilters({ coachIds: ["c1"], resourceTypes: ["cage"] }),
      ),
    );
    expect(sp.has("tab")).toBe(false);
  });

  it("carries the date range", () => {
    const f = normalizeFilters({ from: "2026-08-01", to: "2026-08-31" });
    const sp = new URLSearchParams(filtersToQueryString(f));
    expect(sp.get("from")).toBe("2026-08-01");
    expect(sp.get("to")).toBe("2026-08-31");
  });

  it("carries every selected coach", () => {
    const f = normalizeFilters({ coachIds: ["c1", "c2"] });
    const sp = new URLSearchParams(filtersToQueryString(f));
    expect(sp.getAll("coachIds")).toEqual(["c1", "c2"]);
  });

  it("carries every selected resource type", () => {
    const f = normalizeFilters({ resourceTypes: ["cage", "bullpen"] });
    const sp = new URLSearchParams(filtersToQueryString(f));
    expect(sp.getAll("resourceTypes")).toEqual(["cage", "bullpen"]);
  });

  it("omits coach + resource keys entirely when nothing is selected", () => {
    const sp = new URLSearchParams(filtersToQueryString(normalizeFilters({})));
    expect(sp.has("coachIds")).toBe(false);
    expect(sp.has("resourceTypes")).toBe(false);
  });
});

describe("filtersToQueryString — round trip", () => {
  it("round-trips the default filters", () => {
    const original = normalizeFilters({});
    const restored = filtersFromURLSearchParams(
      new URLSearchParams(filtersToQueryString(original)),
    );
    expect(restored).toEqual(original);
  });

  it("round-trips a fully-specified filter set", () => {
    const original = normalizeFilters({
      from: "2026-07-01",
      to: "2026-07-31",
      coachIds: ["c1", "c2"],
      resourceTypes: ["cage", "weight_room"],
    });
    const restored = filtersFromURLSearchParams(
      new URLSearchParams(filtersToQueryString(original)),
    );
    expect(restored).toEqual(original);
  });
});

describe("normalizeFilters — resource types", () => {
  it("drops values that are not a known resource type", () => {
    const f = normalizeFilters({ resourceTypes: ["cage", "mound", ""] });
    expect(f.resourceTypes).toEqual(["cage"]);
  });

  it("empty means no resource-type filter", () => {
    expect(normalizeFilters({}).resourceTypes).toEqual([]);
  });
});
