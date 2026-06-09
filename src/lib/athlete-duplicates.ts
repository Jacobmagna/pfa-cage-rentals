// Pure duplicate-athlete detection (#17 roster dedup). NO db imports —
// every function here is total over its inputs and side-effect-free so it
// can be unit-tested in isolation and reused on either side of the wire.
//
// The loader (src/lib/server/athlete-actions.ts) reads athletes +
// dismissals, then hands them to findDuplicateGroups; the page renders the
// groups. Merge/dismiss writes live elsewhere.

// Minimal athlete shape this module reasons about. birthday is the
// "YYYY-MM-DD" calendar string (or null = unknown).
export type DupAthlete = {
  id: string;
  firstName: string;
  lastName: string;
  birthday: string | null;
};

export type DuplicateGroup = {
  athleteIds: string[];
  matchType: "exact" | "possible";
};

// Normalized name key for grouping. Trim + lowercase each name part so
// trivial casing/whitespace differences collapse to one bucket. Mirrors
// naturalKey() in src/db/seed-athletes.ts:101 (minus the birthday part,
// which we compare separately for compatibility).
export function normalizeNameKey(firstName: string, lastName: string): string {
  return [firstName.trim().toLowerCase(), lastName.trim().toLowerCase()].join(
    " ",
  );
}

// Canonical, order-independent key for an athlete pair. Used both to look
// up persisted dismissals and to store them — (X,Y) and (Y,X) collapse to
// one key.
export function dismissalKey(idA: string, idB: string): string {
  return [idA, idB].sort().join("|");
}

// Two birthdays are "compatible" for duplicate detection when at least one
// is unknown (null) OR they are exactly equal. Only two KNOWN, DIFFERENT
// birthdays prove the athletes are distinct people.
export function birthdaysCompatible(
  a: string | null,
  b: string | null,
): boolean {
  if (a === null || b === null) return true;
  return a === b;
}

// Group athletes that are likely the same person entered twice.
//
//   1. Bucket by normalizeNameKey (same first+last, case/space-insensitive).
//   2. Within a bucket, draw an undirected edge between every pair whose
//      birthdays are compatible AND whose dismissalKey is NOT dismissed.
//   3. Connected components (union-find) over those edges; keep size >= 2.
//   4. matchType = "exact" iff the component contains at least one edge
//      whose two birthdays are equal AND both non-null (strong evidence);
//      otherwise "possible" (only birthday-blank compatibility holds it
//      together).
//   5. Deterministic output: members sorted by id within a group, groups
//      sorted by their smallest member id.
export function findDuplicateGroups(
  athletes: DupAthlete[],
  dismissed: Set<string>,
): DuplicateGroup[] {
  // Bucket by normalized name.
  const buckets = new Map<string, DupAthlete[]>();
  for (const a of athletes) {
    const key = normalizeNameKey(a.firstName, a.lastName);
    const list = buckets.get(key);
    if (list) list.push(a);
    else buckets.set(key, [a]);
  }

  const groups: DuplicateGroup[] = [];

  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;

    // Union-find over the bucket's athletes (indexed by position).
    const parent = bucket.map((_, i) => i);
    const find = (x: number): number => {
      let root = x;
      while (parent[root] !== root) root = parent[root];
      // Path-compress.
      let cur = x;
      while (parent[cur] !== root) {
        const next = parent[cur];
        parent[cur] = root;
        cur = next;
      }
      return root;
    };
    const union = (x: number, y: number): void => {
      const rx = find(x);
      const ry = find(y);
      if (rx !== ry) parent[rx] = ry;
    };

    // Track which components have at least one "exact" (equal non-null
    // birthday) edge. Keyed by the in-bucket component root id at the time
    // of the edge; resolved to the final root after all unions.
    const exactEdges: Array<[number, number]> = [];

    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const a = bucket[i];
        const b = bucket[j];
        if (!birthdaysCompatible(a.birthday, b.birthday)) continue;
        if (dismissed.has(dismissalKey(a.id, b.id))) continue;
        union(i, j);
        if (
          a.birthday !== null &&
          b.birthday !== null &&
          a.birthday === b.birthday
        ) {
          exactEdges.push([i, j]);
        }
      }
    }

    // Collect members per final component root.
    const components = new Map<number, number[]>();
    for (let i = 0; i < bucket.length; i += 1) {
      const root = find(i);
      const list = components.get(root);
      if (list) list.push(i);
      else components.set(root, [i]);
    }

    // Which final roots carry an exact edge.
    const exactRoots = new Set<number>();
    for (const [i] of exactEdges) exactRoots.add(find(i));

    for (const [root, indices] of components) {
      if (indices.length < 2) continue;
      const athleteIds = indices
        .map((idx) => bucket[idx].id)
        .sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
      groups.push({
        athleteIds,
        matchType: exactRoots.has(root) ? "exact" : "possible",
      });
    }
  }

  // Deterministic group order: by smallest member id.
  groups.sort((g1, g2) => {
    const a = g1.athleteIds[0];
    const b = g2.athleteIds[0];
    return a < b ? -1 : a > b ? 1 : 0;
  });

  return groups;
}
