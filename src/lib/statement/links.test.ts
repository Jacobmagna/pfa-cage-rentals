// payment-statement SPEC §8 — every Statements link carries the filters that
// are on screen.
//
// The failure this pins is quiet: a switcher or a roster row that dropped
// `from`/`to` would render a DIFFERENT period's arithmetic under a header still
// naming the old one — and both pages would look correct in isolation.

import { describe, expect, it } from "vitest";
import { normalizeFilters } from "@/lib/reports/filters";
import { statementHref } from "./links";

const FILTERS = normalizeFilters({
  from: "2026-07-01",
  to: "2026-07-31",
  coachIds: ["coach-a", "coach-b"],
  resourceTypes: ["cage", "bullpen"],
  programId: "prog-1",
});

function params(href: string): URLSearchParams {
  return new URLSearchParams(href.slice(href.indexOf("?") + 1));
}

describe("statementHref — preserves the current filters", () => {
  it("points at /admin/reports", () => {
    expect(statementHref(FILTERS, "cage").startsWith("/admin/reports?")).toBe(
      true,
    );
  });

  it("carries every filter through unchanged", () => {
    const p = params(statementHref(FILTERS, "work"));
    expect(p.get("from")).toBe("2026-07-01");
    expect(p.get("to")).toBe("2026-07-31");
    expect(p.getAll("coachIds")).toEqual(["coach-a", "coach-b"]);
    expect(p.getAll("resourceTypes")).toEqual(["cage", "bullpen"]);
    expect(p.get("programId")).toBe("prog-1");
  });

  it("sets tab=statements and the account, each exactly once", () => {
    // `filtersToQueryString` emits no `tab` of its own (reports/filters.ts), so
    // a duplicate here would mean someone added one there — and
    // `normalizeReportTab` takes the FIRST value, so a duplicate is a silent
    // wrong-tab bug rather than an error.
    const p = params(statementHref(FILTERS, "work"));
    expect(p.getAll("tab")).toEqual(["statements"]);
    expect(p.getAll("account")).toEqual(["work"]);
  });

  it.each(["cage", "work"] as const)("round-trips account=%s", (account) => {
    expect(params(statementHref(FILTERS, account)).get("account")).toBe(
      account,
    );
  });
});

describe("statementHref — the overrides", () => {
  it("narrows the coach scope for a roster row, keeping everything else", () => {
    // This is the link that flips the tab from the roll-up to one document.
    const p = params(
      statementHref(FILTERS, "cage", { coachIds: ["coach-b"] }),
    );
    expect(p.getAll("coachIds")).toEqual(["coach-b"]);
    expect(p.get("from")).toBe("2026-07-01");
    expect(p.get("to")).toBe("2026-07-31");
    expect(p.get("programId")).toBe("prog-1");
  });

  it("replaces the period for a month chip, keeping the coach scope", () => {
    const p = params(
      statementHref(FILTERS, "work", { from: "2026-06-01", to: "2026-06-30" }),
    );
    expect(p.get("from")).toBe("2026-06-01");
    expect(p.get("to")).toBe("2026-06-30");
    expect(p.getAll("coachIds")).toEqual(["coach-a", "coach-b"]);
    expect(p.get("account")).toBe("work");
  });

  it("an empty coach override means ALL coaches, not 'unchanged'", () => {
    // Distinguishable from `undefined`: [] is a real scope (the roll-up).
    const p = params(statementHref(FILTERS, "cage", { coachIds: [] }));
    expect(p.getAll("coachIds")).toEqual([]);
  });

  it("does not mutate the caller's filter object", () => {
    const before = JSON.stringify(FILTERS);
    statementHref(FILTERS, "work", {
      coachIds: ["x"],
      from: "2026-01-01",
      to: "2026-01-31",
    });
    expect(JSON.stringify(FILTERS)).toBe(before);
  });
});
