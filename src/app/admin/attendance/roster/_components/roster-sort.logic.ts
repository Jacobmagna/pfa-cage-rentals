// Pure, tested sort for the admin Roster table. Extracted from
// roster-client.tsx so the ordering rules can be unit-tested without a
// DOM. Follows the repo's `.logic.ts` + `.test.ts` convention (see
// sessions/filters.logic.ts, list-search.logic.ts).
//
// Sortable columns: First name, Last name, and Birthday. Term and
// Programs are intentionally NOT sortable (out of scope).
//
// Rules:
//   - First / Last: case-insensitive, locale-agnostic alphabetical via
//     localeCompare with sensitivity:"base". asc = A→Z, desc = Z→A.
//   - Birthday: compared as the raw "YYYY-MM-DD" ISO string —
//     lexicographic text order matches calendar order, so NO `new Date()`
//     is needed (and no timezone shift risk). asc = oldest date first,
//     desc = most-recent date first. NULL birthdays ALWAYS sort to the
//     bottom in BOTH directions.
//   - Stable: ties preserve the input order (Array.prototype.sort is
//     stable in modern engines; we lean on that and never reorder equal
//     rows).
//   - Pure: returns a NEW array; the input is never mutated.

/** Minimal shape this sorter reads — any roster row satisfies it. */
export type SortableAthlete = {
  firstName: string;
  lastName: string;
  birthday: string | null;
};

export type SortKey = "firstName" | "lastName" | "birthday";
export type SortDir = "asc" | "desc";

const collator = new Intl.Collator(undefined, { sensitivity: "base" });

/**
 * Return a NEW array of `rows` sorted by `key` in direction `dir`.
 *
 * - First / Last: case-insensitive `localeCompare` (sensitivity:"base").
 * - Birthday: lexicographic "YYYY-MM-DD" comparison (no Date parsing);
 *   nulls always last regardless of direction.
 * - Stable for equal rows; never mutates the input array.
 */
export function sortAthletes<T extends SortableAthlete>(
  rows: readonly T[],
  key: SortKey,
  dir: SortDir,
): T[] {
  const factor = dir === "asc" ? 1 : -1;

  // Decorate with original index so we can keep a stable order for ties
  // (and for nulls that all collapse to the bottom). This guarantees
  // stability independent of the engine's own sort stability.
  const decorated = rows.map((row, index) => ({ row, index }));

  decorated.sort((a, b) => {
    const cmp =
      key === "birthday"
        ? compareBirthday(a.row.birthday, b.row.birthday)
        : factor * collator.compare(a.row[key], b.row[key]);
    // For names, ties (cmp === 0) fall through to index. For birthdays,
    // compareBirthday already returns 0 only for equal-or-both-null which
    // also fall through to index.
    if (cmp !== 0) return cmp;
    return a.index - b.index;
  });

  return decorated.map((d) => d.row);

  function compareBirthday(x: string | null, y: string | null): number {
    // Nulls always sink to the bottom, regardless of direction.
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    // "YYYY-MM-DD" strings compare lexicographically == chronologically.
    if (x === y) return 0;
    return factor * (x < y ? -1 : 1);
  }
}
