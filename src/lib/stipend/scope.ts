// stipend — the COACH SCOPE conversion, and the convention mismatch it exists
// to name.
//
// Pure on purpose. It lives here rather than in `fetch.ts` because `fetch.ts`
// imports `@/db`, which makes it unimportable from a unit test — and this is
// exactly the kind of one-line conversion that has to be tested.

/**
 * 🔴 TWO OPPOSITE CONVENTIONS MEET HERE, AND THEY MADE A REAL BUG.
 *
 * `NormalizedFilters.coachIds` uses **`[]` to mean ALL COACHES** — it is what
 * the filter bar produces when nobody is selected, which is the DEFAULT view.
 *
 * `lib/stipend/fetch.ts` uses **`undefined` for all and `[]` for NONE**,
 * deliberately: a caller that computed an empty scope must not silently widen
 * to everyone.
 *
 * Those are exact opposites, and two of the three callers got it wrong. The
 * Work tab and the Excel download passed `filters.coachIds` straight through,
 * so on the default "All coaches" view **every stipend vanished from the
 * table and from the grand total** — a coach's covered hours showed as real
 * hours at $0 with nothing on the page paying for them. Only
 * `statement/fetch.ts` converted correctly, which is why the statement and
 * the Work tab disagreed in the other direction too.
 *
 * ▶ Found by rendering the page and reading it, not by any assertion — the
 * ninth time this repo has learned that lesson. Route every filter-derived
 * scope through this function rather than restating the ternary, so there is
 * ONE place the mismatch is handled and named.
 */
export function coachScopeFromFilters(
  filterCoachIds: readonly string[],
): string[] | undefined {
  // Copied, not aliased: the returned array is handed to a query builder, and
  // the filters object is re-serialized into every link the page builds.
  return filterCoachIds.length > 0 ? [...filterCoachIds] : undefined;
}
