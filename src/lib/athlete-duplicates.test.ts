import { describe, expect, it } from "vitest";
import {
  birthdaysCompatible,
  dismissalKey,
  findDuplicateGroups,
  normalizeNameKey,
  type DupAthlete,
} from "./athlete-duplicates";

describe("normalizeNameKey", () => {
  it("trims and lowercases both name parts", () => {
    expect(normalizeNameKey("  John ", " Smith ")).toBe("john smith");
  });

  it("collapses casing/whitespace differences to one key", () => {
    expect(normalizeNameKey("JOHN", "smith")).toBe(
      normalizeNameKey("john", "SMITH"),
    );
  });

  it("keeps different names distinct", () => {
    expect(normalizeNameKey("John", "Smith")).not.toBe(
      normalizeNameKey("Jane", "Smith"),
    );
  });
});

describe("dismissalKey", () => {
  it("is order-independent (canonical)", () => {
    expect(dismissalKey("b", "a")).toBe(dismissalKey("a", "b"));
  });

  it("joins the sorted pair with a pipe", () => {
    expect(dismissalKey("a", "b")).toBe("a|b");
  });
});

describe("birthdaysCompatible", () => {
  it("both null => compatible", () => {
    expect(birthdaysCompatible(null, null)).toBe(true);
  });
  it("one null => compatible", () => {
    expect(birthdaysCompatible(null, "2010-01-01")).toBe(true);
    expect(birthdaysCompatible("2010-01-01", null)).toBe(true);
  });
  it("equal non-null => compatible", () => {
    expect(birthdaysCompatible("2010-01-01", "2010-01-01")).toBe(true);
  });
  it("different non-null => NOT compatible", () => {
    expect(birthdaysCompatible("2010-01-01", "2011-02-02")).toBe(false);
  });
});

function ath(
  id: string,
  firstName: string,
  lastName: string,
  birthday: string | null,
): DupAthlete {
  return { id, firstName, lastName, birthday };
}

describe("findDuplicateGroups", () => {
  it("both birthdays null => possible group", () => {
    const groups = findDuplicateGroups(
      [ath("a1", "John", "Smith", null), ath("a2", "john", "smith", null)],
      new Set(),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].matchType).toBe("possible");
    expect(groups[0].athleteIds).toEqual(["a1", "a2"]);
  });

  it("one null + one date => possible group", () => {
    const groups = findDuplicateGroups(
      [
        ath("a1", "John", "Smith", null),
        ath("a2", "John", "Smith", "2010-05-01"),
      ],
      new Set(),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].matchType).toBe("possible");
  });

  it("same non-null date => exact group", () => {
    const groups = findDuplicateGroups(
      [
        ath("a1", "John", "Smith", "2010-05-01"),
        ath("a2", "John", "Smith", "2010-05-01"),
      ],
      new Set(),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].matchType).toBe("exact");
  });

  it("two different non-null dates => NOT grouped", () => {
    const groups = findDuplicateGroups(
      [
        ath("a1", "John", "Smith", "2010-05-01"),
        ath("a2", "John", "Smith", "2011-06-02"),
      ],
      new Set(),
    );
    expect(groups).toHaveLength(0);
  });

  it("dismissed pair => not grouped", () => {
    const groups = findDuplicateGroups(
      [ath("a1", "John", "Smith", null), ath("a2", "John", "Smith", null)],
      new Set([dismissalKey("a1", "a2")]),
    );
    expect(groups).toHaveLength(0);
  });

  it("3-way same name: A-B compatible, A-C dismissed => {A,B} only", () => {
    // A-B compatible (both null). A-C dismissed. B-C compatible (both null)
    // would normally chain them, so we make C's birthday distinct from B to
    // sever B-C, leaving only the A-B edge.
    const groups = findDuplicateGroups(
      [
        ath("a", "John", "Smith", null),
        ath("b", "John", "Smith", "2010-05-01"),
        ath("c", "John", "Smith", "2011-06-02"),
      ],
      new Set([dismissalKey("a", "c")]),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].athleteIds).toEqual(["a", "b"]);
    // a-b is null+date => possible.
    expect(groups[0].matchType).toBe("possible");
  });

  it("different names are never grouped", () => {
    const groups = findDuplicateGroups(
      [
        ath("a1", "John", "Smith", "2010-05-01"),
        ath("a2", "Jane", "Smith", "2010-05-01"),
      ],
      new Set(),
    );
    expect(groups).toHaveLength(0);
  });

  it("transitively chains a 3-way component and flags exact", () => {
    // a(null)-b(date) possible, b(date)-c(same date) exact => one component
    // {a,b,c}, matchType exact because of the b-c equal-birthday edge.
    const groups = findDuplicateGroups(
      [
        ath("a", "John", "Smith", null),
        ath("b", "John", "Smith", "2010-05-01"),
        ath("c", "John", "Smith", "2010-05-01"),
      ],
      new Set(),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].athleteIds).toEqual(["a", "b", "c"]);
    expect(groups[0].matchType).toBe("exact");
  });

  it("returns groups sorted by smallest member id", () => {
    const groups = findDuplicateGroups(
      [
        ath("m1", "Zed", "Zulu", null),
        ath("m2", "Zed", "Zulu", null),
        ath("a1", "Amy", "Adams", null),
        ath("a2", "Amy", "Adams", null),
      ],
      new Set(),
    );
    expect(groups).toHaveLength(2);
    expect(groups[0].athleteIds[0]).toBe("a1");
    expect(groups[1].athleteIds[0]).toBe("m1");
  });
});
