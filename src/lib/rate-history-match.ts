// SPEC rate-effective-dating §7 — joining a RE-PRICE audit row to the rate
// change that caused it, for the 3-dot history menu.
//
// A plain module, not part of src/lib/server/rate-history.ts, for the reason
// the §6 copy is a plain module: the unit suite runs in `environment: "node"`
// (vitest.config.ts) and rate-history.ts imports `@/db`. The matching rule is
// the part with a bug class in it, so it lives where it can be pinned by
// tests.
//
// ── How the join works ───────────────────────────────────────────────────
// There is no foreign key between the rate change and its retro. Two
// independent signals stand in, and BOTH are required: the re-price audit row
// carries the SAME `effectiveFrom` ISO string the rate row was saved with, AND
// it is written in the same request, milliseconds later. So: same
// effectiveFrom, ts at or after the rate change, inside a 5-minute window.
//
// ── 🔴 WHY THIS DEDUPES BY entityId ──────────────────────────────────────
// A program-default retro writes ONE audit row PER (coach, program) GROUP, so
// the menu has to add the groups up or it would report only whichever one it
// matched first. But summing blindly double-counts a DOUBLE SUBMIT: two
// overlapping applies each write their audit rows, and while the second one's
// UPDATEs correctly match nothing (`IS DISTINCT FROM` at the SQL layer), its
// audit INSERT is unconditional. Both rows then carry the same entityId, the
// same effectiveFrom and a ts inside the window — and the menu reported
// "28 entries, +$880.00" for a change that moved 14 and $440.00.
//
// So: at most ONE row per entityId, the one written NEAREST the rate change.
// Money is unaffected either way — this is the reversal record's clarity, and
// a reader deciding whether to undo needs the count to be the count.

/** One re-price audit row, reduced to what the menu needs. */
export type RepriceAudit = {
  /** "<coachId>::<programId>" — the group this row reports on. */
  entityId: string;
  effectiveFromIso: string | null;
  ts: Date;
  logCount: number;
  deltaCents: number;
};

/** Widest window we will believe joins a re-price to the save that caused it. */
export const REPRICE_MATCH_WINDOW_MS = 5 * 60 * 1000;

/**
 * Sums the re-price groups belonging to one rate change — counting each group
 * exactly once. Returns null when no group matches.
 */
export function matchReprice(
  repriceRows: readonly RepriceAudit[],
  effectiveFrom: Date | null,
  setAt: Date,
): { logCount: number; deltaCents: number } | null {
  if (!effectiveFrom) return null;
  const wantedIso = effectiveFrom.toISOString();

  // One winner per group. A duplicate from a double submit is a SECOND row for
  // a group already represented, so it is dropped rather than added.
  const bestByEntity = new Map<string, { gap: number; row: RepriceAudit }>();
  for (const r of repriceRows) {
    if (r.effectiveFromIso !== wantedIso) continue;
    const gap = r.ts.getTime() - setAt.getTime();
    if (gap < 0 || gap > REPRICE_MATCH_WINDOW_MS) continue;
    const held = bestByEntity.get(r.entityId);
    // Nearest to the rate change wins; a tie keeps the first seen, so the
    // result does not depend on how the rows happened to be ordered.
    if (!held || gap < held.gap) bestByEntity.set(r.entityId, { gap, row: r });
  }

  if (bestByEntity.size === 0) return null;
  let logCount = 0;
  let deltaCents = 0;
  for (const { row } of bestByEntity.values()) {
    logCount += row.logCount;
    deltaCents += row.deltaCents;
  }
  return { logCount, deltaCents };
}
