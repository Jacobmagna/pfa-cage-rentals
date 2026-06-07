// QA10 W3-polish16: detect overlapping hour-logs for the SAME coach.
//
// A coach physically can't run two sessions at the same time, so two of their
// hour-logs that overlap in time = a double-pay / duplicate-entry risk that an
// admin should review. Half-open overlap matches the reconciliation rule used
// elsewhere (see `coach-hour-log.ts`): two intervals that merely touch at an
// endpoint (one ends exactly when the other starts) do NOT count as
// overlapping. Program is ignored — a coach can't be in two places regardless
// of which program each log is for.
//
// Pure + unit-tested (`hour-log-overlap.test.ts`).
export function findOverlappingLogIds(
  logs: { id: string; coachId: string; startMs: number; endMs: number }[],
): Set<string> {
  const overlapping = new Set<string>();

  // Group by coach — overlaps only matter within a single coach.
  const byCoach = new Map<string, typeof logs>();
  for (const log of logs) {
    const group = byCoach.get(log.coachId);
    if (group) group.push(log);
    else byCoach.set(log.coachId, [log]);
  }

  for (const group of byCoach.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const a = group[i]!;
        const b = group[j]!;
        // Half-open overlap: touching endpoints do NOT overlap.
        if (a.startMs < b.endMs && a.endMs > b.startMs) {
          overlapping.add(a.id);
          overlapping.add(b.id);
        }
      }
    }
  }

  return overlapping;
}
