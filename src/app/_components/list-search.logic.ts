// Pure, client-side name-search predicate shared by the people-list
// surfaces (Roster, Coaches, Archive, Payments balances). Filters
// already-loaded rows — no server round-trip, no query params.
//
// Matching rules (case-insensitive, whitespace-trimmed):
//   - empty query → matches everything (no-op filter)
//   - the query is matched as a substring against each supplied field
//     AND against the joined "first last" full name, so typing part of
//     either name, or a "first last" fragment that spans both, hits.

/** Normalize a query: trim + lowercase. Empty (after trim) means "match all". */
export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

/**
 * True when the normalized query is a substring of any of the provided
 * fields. Pass the individual name parts (first, last) plus any extra
 * searchable fields (e.g. email); the helper also tests the joined
 * "first last" full name so a fragment spanning both names matches.
 *
 * `query` may be pre-normalized or raw — it is normalized internally so
 * callers can normalize once per keystroke and pass it through.
 */
export function nameMatchesQuery(
  query: string,
  fields: Array<string | null | undefined>,
): boolean {
  const q = normalizeQuery(query);
  if (q === "") return true;

  const haystacks = fields
    .filter((f): f is string => typeof f === "string" && f.length > 0)
    .map((f) => f.toLowerCase());

  return haystacks.some((h) => h.includes(q));
}

/**
 * Convenience builder for first/last name surfaces: returns the field
 * list to hand to {@link nameMatchesQuery} — first, last, and the joined
 * "first last" full name. Extra fields (e.g. email) can be appended.
 */
export function nameFields(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
  ...extra: Array<string | null | undefined>
): Array<string | null | undefined> {
  const first = firstName ?? "";
  const last = lastName ?? "";
  const full = `${first} ${last}`.trim();
  return [first, last, full, ...extra];
}
