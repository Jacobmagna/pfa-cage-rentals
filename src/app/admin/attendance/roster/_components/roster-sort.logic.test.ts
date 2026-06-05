import { describe, expect, it } from "vitest";
import { sortAthletes, type SortableAthlete } from "./roster-sort.logic";

// Locks the Roster sort ordering rules: First/Last case-insensitive
// alphabetical, Birthday by ISO date with most-recent-first on desc, and
// null birthdays always last in BOTH directions. Also pins stability and
// the no-mutation / new-array contract.

type Row = SortableAthlete & { id: string };

const make = (
  id: string,
  firstName: string,
  lastName: string,
  birthday: string | null,
): Row => ({ id, firstName, lastName, birthday });

const ids = (rows: Row[]) => rows.map((r) => r.id);

describe("sortAthletes — First name", () => {
  const rows: Row[] = [
    make("a", "Charlie", "X", "2010-01-01"),
    make("b", "alice", "Y", "2011-01-01"),
    make("c", "Bob", "Z", "2012-01-01"),
  ];

  it("sorts A→Z, case-insensitively, on asc", () => {
    expect(ids(sortAthletes(rows, "firstName", "asc"))).toEqual([
      "b", // alice
      "c", // Bob
      "a", // Charlie
    ]);
  });

  it("sorts Z→A, case-insensitively, on desc", () => {
    expect(ids(sortAthletes(rows, "firstName", "desc"))).toEqual([
      "a", // Charlie
      "c", // Bob
      "b", // alice
    ]);
  });
});

describe("sortAthletes — Last name", () => {
  const rows: Row[] = [
    make("a", "X", "delta", "2010-01-01"),
    make("b", "Y", "Alpha", "2011-01-01"),
    make("c", "Z", "charlie", "2012-01-01"),
  ];

  it("sorts A→Z, case-insensitively, on asc", () => {
    expect(ids(sortAthletes(rows, "lastName", "asc"))).toEqual([
      "b", // Alpha
      "c", // charlie
      "a", // delta
    ]);
  });

  it("sorts Z→A, case-insensitively, on desc", () => {
    expect(ids(sortAthletes(rows, "lastName", "desc"))).toEqual([
      "a", // delta
      "c", // charlie
      "b", // Alpha
    ]);
  });
});

describe("sortAthletes — Birthday", () => {
  const rows: Row[] = [
    make("mid", "M", "M", "2009-06-15"),
    make("old", "O", "O", "2005-12-31"),
    make("new", "N", "N", "2012-03-01"),
  ];

  it("asc = oldest date first", () => {
    expect(ids(sortAthletes(rows, "birthday", "asc"))).toEqual([
      "old", // 2005
      "mid", // 2009
      "new", // 2012
    ]);
  });

  it("desc = most recent date first", () => {
    expect(ids(sortAthletes(rows, "birthday", "desc"))).toEqual([
      "new", // 2012
      "mid", // 2009
      "old", // 2005
    ]);
  });

  it("compares by full Y-M-D, not just year", () => {
    const withinYear: Row[] = [
      make("dec", "D", "D", "2010-12-01"),
      make("jan", "J", "J", "2010-01-05"),
      make("jun", "U", "U", "2010-06-20"),
    ];
    expect(ids(sortAthletes(withinYear, "birthday", "asc"))).toEqual([
      "jan",
      "jun",
      "dec",
    ]);
  });
});

describe("sortAthletes — null birthdays always last", () => {
  const rows: Row[] = [
    make("n1", "A", "A", null),
    make("old", "O", "O", "2005-01-01"),
    make("n2", "B", "B", null),
    make("new", "N", "N", "2012-01-01"),
  ];

  it("nulls sink to the bottom on asc", () => {
    const out = ids(sortAthletes(rows, "birthday", "asc"));
    expect(out.slice(0, 2)).toEqual(["old", "new"]);
    expect(out.slice(2)).toEqual(["n1", "n2"]); // nulls last, stable
  });

  it("nulls sink to the bottom on desc too", () => {
    const out = ids(sortAthletes(rows, "birthday", "desc"));
    expect(out.slice(0, 2)).toEqual(["new", "old"]);
    expect(out.slice(2)).toEqual(["n1", "n2"]); // nulls still last, stable
  });
});

describe("sortAthletes — stability & purity", () => {
  it("preserves input order for ties (stable)", () => {
    // Three rows with the same first name (case-insensitive) keep their
    // original relative order.
    const rows: Row[] = [
      make("a", "Sam", "One", "2010-01-01"),
      make("b", "sam", "Two", "2011-01-01"),
      make("c", "SAM", "Three", "2012-01-01"),
    ];
    expect(ids(sortAthletes(rows, "firstName", "asc"))).toEqual(["a", "b", "c"]);
    expect(ids(sortAthletes(rows, "firstName", "desc"))).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("keeps equal birthdays (and nulls) in input order", () => {
    const rows: Row[] = [
      make("a", "A", "A", "2010-05-05"),
      make("b", "B", "B", "2010-05-05"),
      make("n1", "C", "C", null),
      make("n2", "D", "D", null),
    ];
    expect(ids(sortAthletes(rows, "birthday", "asc"))).toEqual([
      "a",
      "b",
      "n1",
      "n2",
    ]);
  });

  it("returns a NEW array and does not mutate the input", () => {
    const rows: Row[] = [
      make("a", "Charlie", "X", "2010-01-01"),
      make("b", "Alice", "Y", "2011-01-01"),
    ];
    const before = [...rows];
    const out = sortAthletes(rows, "firstName", "asc");
    expect(out).not.toBe(rows); // new array reference
    expect(rows).toEqual(before); // input untouched (order preserved)
    expect(ids(out)).toEqual(["b", "a"]); // sorted result
  });
});
