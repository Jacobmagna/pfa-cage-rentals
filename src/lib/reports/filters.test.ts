// Unit tests for the pure filter parsing — focused on the QA4 scope
// feature (cage/program checkboxes) which has subtle GET-form
// semantics: an unchecked checkbox submits nothing, indistinguishable
// from a fresh load. The hidden `scopeApplied` marker disambiguates,
// and these tests lock that contract down so a refactor can't silently
// flip a default.

import { describe, expect, it } from "vitest";
import {
  filtersFromURLSearchParams,
  filtersToQueryString,
  normalizeFilters,
} from "./filters";

describe("normalizeFilters — scope defaults", () => {
  it("fresh load (no scope params) defaults BOTH categories on", () => {
    const f = normalizeFilters({});
    expect(f.includeCageSessions).toBe(true);
    expect(f.includeProgramHours).toBe(true);
  });

  it("scopeApplied with NEITHER box turns BOTH off", () => {
    const f = normalizeFilters({ scopeApplied: "1" });
    expect(f.includeCageSessions).toBe(false);
    expect(f.includeProgramHours).toBe(false);
  });

  it("scopeApplied + includeCage only → cage on, program off", () => {
    const f = normalizeFilters({ scopeApplied: "1", includeCage: "1" });
    expect(f.includeCageSessions).toBe(true);
    expect(f.includeProgramHours).toBe(false);
  });

  it("scopeApplied + includeProgram only → program on, cage off", () => {
    const f = normalizeFilters({ scopeApplied: "1", includeProgram: "1" });
    expect(f.includeCageSessions).toBe(false);
    expect(f.includeProgramHours).toBe(true);
  });

  it("scopeApplied + both boxes → both on", () => {
    const f = normalizeFilters({
      scopeApplied: "1",
      includeCage: "1",
      includeProgram: "1",
    });
    expect(f.includeCageSessions).toBe(true);
    expect(f.includeProgramHours).toBe(true);
  });

  it("treats an empty-string checkbox value as absent (off)", () => {
    const f = normalizeFilters({ scopeApplied: "1", includeCage: "" });
    expect(f.includeCageSessions).toBe(false);
  });
});

describe("filtersToQueryString / round-trip — scope preservation", () => {
  it("always emits scopeApplied=1 and the on categories", () => {
    const f = normalizeFilters({
      scopeApplied: "1",
      includeCage: "1",
      includeProgram: "1",
    });
    const qs = filtersToQueryString(f);
    const sp = new URLSearchParams(qs);
    expect(sp.get("scopeApplied")).toBe("1");
    expect(sp.get("includeCage")).toBe("1");
    expect(sp.get("includeProgram")).toBe("1");
  });

  it("omits includeCage when cage is off, keeps the marker", () => {
    const f = normalizeFilters({ scopeApplied: "1", includeProgram: "1" });
    const sp = new URLSearchParams(filtersToQueryString(f));
    expect(sp.get("scopeApplied")).toBe("1");
    expect(sp.has("includeCage")).toBe(false);
    expect(sp.get("includeProgram")).toBe("1");
  });

  it("round-trips a cage-only scope through the URL", () => {
    const original = normalizeFilters({ scopeApplied: "1", includeCage: "1" });
    const sp = new URLSearchParams(filtersToQueryString(original));
    const restored = filtersFromURLSearchParams(sp);
    expect(restored.includeCageSessions).toBe(true);
    expect(restored.includeProgramHours).toBe(false);
  });

  it("round-trips a program-only scope through the URL", () => {
    const original = normalizeFilters({
      scopeApplied: "1",
      includeProgram: "1",
    });
    const sp = new URLSearchParams(filtersToQueryString(original));
    const restored = filtersFromURLSearchParams(sp);
    expect(restored.includeCageSessions).toBe(false);
    expect(restored.includeProgramHours).toBe(true);
  });

  it("round-trips a both-off scope (marker present, no boxes)", () => {
    const original = normalizeFilters({ scopeApplied: "1" });
    const sp = new URLSearchParams(filtersToQueryString(original));
    expect(sp.get("scopeApplied")).toBe("1");
    const restored = filtersFromURLSearchParams(sp);
    expect(restored.includeCageSessions).toBe(false);
    expect(restored.includeProgramHours).toBe(false);
  });

  it("round-trips the default (both-on) scope", () => {
    const original = normalizeFilters({});
    const sp = new URLSearchParams(filtersToQueryString(original));
    const restored = filtersFromURLSearchParams(sp);
    expect(restored.includeCageSessions).toBe(true);
    expect(restored.includeProgramHours).toBe(true);
  });
});
