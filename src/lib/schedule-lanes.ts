// QA10 W3.8a: pure lane-assignment for the combined Program Schedule
// timeline. Given the day's blocks, greedily partition them into the
// MINIMUM number of horizontal lanes (rows) so that no two blocks in the
// same lane overlap in time. Non-overlapping blocks share a lane; only
// where blocks overlap do they stack into separate lanes.
//
// Overlap is HALF-OPEN: a block ending exactly when another starts does
// NOT overlap, so touching endpoints can share a lane. The algorithm is a
// classic greedy minimum-lane interval partition:
//   - sort blocks by startAt (tie-break on id for determinism),
//   - for each block, place it in the lowest-index lane whose last placed
//     block ENDS no later than this block STARTS; else open a new lane.
//
// Pure + deterministic — safe to call during render (no state).

export type LaneBlock = { id: string; startAt: Date; endAt: Date };
export type LaneResult = {
  laneByBlockId: Map<string, number>;
  laneCount: number;
};

export function assignLanes(blocks: LaneBlock[]): LaneResult {
  const laneByBlockId = new Map<string, number>();
  if (blocks.length === 0) {
    return { laneByBlockId, laneCount: 0 };
  }

  // Sort by start time, tie-break by id for a stable, deterministic order.
  const sorted = [...blocks].sort((a, b) => {
    const sa = a.startAt.getTime();
    const sb = b.startAt.getTime();
    if (sa !== sb) return sa - sb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  // laneEnds[i] = end time (ms) of the last block placed in lane i.
  const laneEnds: number[] = [];

  for (const block of sorted) {
    const start = block.startAt.getTime();
    const end = block.endAt.getTime();

    // Find the lowest-index lane that is free at `start` (half-open: a lane
    // whose last block ends at or before `start` can be reused).
    let placed = -1;
    for (let i = 0; i < laneEnds.length; i++) {
      if (laneEnds[i] <= start) {
        placed = i;
        break;
      }
    }
    if (placed === -1) {
      placed = laneEnds.length;
      laneEnds.push(end);
    } else {
      laneEnds[placed] = end;
    }
    laneByBlockId.set(block.id, placed);
  }

  return { laneByBlockId, laneCount: laneEnds.length };
}
