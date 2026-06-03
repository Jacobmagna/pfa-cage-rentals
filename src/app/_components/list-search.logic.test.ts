import { describe, it, expect } from "vitest";
import { nameMatchesQuery, nameFields, normalizeQuery } from "./list-search.logic";

describe("normalizeQuery", () => {
  it("trims and lowercases", () => {
    expect(normalizeQuery("  Jane  ")).toBe("jane");
  });

  it("collapses to empty for whitespace-only input", () => {
    expect(normalizeQuery("   ")).toBe("");
  });
});

describe("nameMatchesQuery", () => {
  const fields = nameFields("Jane", "Doe");

  it("matches everything for an empty query", () => {
    expect(nameMatchesQuery("", fields)).toBe(true);
    expect(nameMatchesQuery("   ", fields)).toBe(true);
  });

  it("matches on first name (case-insensitive)", () => {
    expect(nameMatchesQuery("jan", fields)).toBe(true);
    expect(nameMatchesQuery("JANE", fields)).toBe(true);
  });

  it("matches on last name", () => {
    expect(nameMatchesQuery("doe", fields)).toBe(true);
  });

  it("matches on a 'first last' full-name fragment", () => {
    expect(nameMatchesQuery("jane d", fields)).toBe(true);
    expect(nameMatchesQuery("ne do", fields)).toBe(true);
  });

  it("trims surrounding whitespace on the query", () => {
    expect(nameMatchesQuery("  doe  ", fields)).toBe(true);
  });

  it("does not match an unrelated query", () => {
    expect(nameMatchesQuery("smith", fields)).toBe(false);
  });

  it("matches on an extra field such as email", () => {
    const withEmail = nameFields("Jane", "Doe", "jane.coach@example.com");
    expect(nameMatchesQuery("example.com", withEmail)).toBe(true);
    expect(nameMatchesQuery("coach@", withEmail)).toBe(true);
  });

  it("tolerates null/undefined name parts", () => {
    const onlyEmail = nameFields(null, null, "solo@pfa.com");
    expect(nameMatchesQuery("solo", onlyEmail)).toBe(true);
    expect(nameMatchesQuery("nope", onlyEmail)).toBe(false);
  });

  it("ignores empty fields when building haystacks", () => {
    expect(nameMatchesQuery("a", nameFields("", ""))).toBe(false);
  });
});
