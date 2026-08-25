// 0r(2) — unit tests for the shared hour-log revalidation surface list.
//
// These are deliberately about the CONTENT of the list, not about
// `revalidatePath`. The bug being prevented was never a broken call — it was
// a correct call against an incomplete list, in a file that cannot be unit
// tested because it is `"use server"`. So the list itself is what gets
// pinned here.

import { describe, expect, it } from "vitest";
import { HOUR_LOG_SURFACES } from "./hour-log-surfaces";

describe("HOUR_LOG_SURFACES", () => {
  // The exact set, so adding or removing a surface is a deliberate edit with
  // a visible diff rather than something that drifts in unnoticed.
  it("is exactly the routes that render hour-log-derived state", () => {
    expect([...HOUR_LOG_SURFACES]).toEqual([
      "/admin",
      "/admin/hour-log",
      "/admin/hour-log/held",
      "/admin/hour-log/schedule",
      "/admin/payments",
      "/admin/reports",
      "/admin/records/accountability",
      "/coach/hour-log",
    ]);
  });

  // The actual Aug 8 regression: `deleteHour` revalidated "/admin/hour-log"
  // and nothing else, so the schedule overlay kept rendering a block status
  // computed from a log that no longer existed. `revalidatePath` does not
  // cascade to nested routes, so "/admin/hour-log" does NOT cover
  // "/admin/hour-log/schedule" — these three are named individually on
  // purpose. Each is called out separately so a failure says which one went.
  it.each([
    ["the schedule overlay", "/admin/hour-log/schedule"],
    ["the dashboard", "/admin"],
    ["the reports tabs", "/admin/reports"],
    ["the coach's own history + confirm list", "/coach/hour-log"],
  ])("includes %s (%s)", (_label, path) => {
    expect(HOUR_LOG_SURFACES).toContain(path);
  });

  it("has no duplicates", () => {
    expect(new Set(HOUR_LOG_SURFACES).size).toBe(HOUR_LOG_SURFACES.length);
  });

  it("holds absolute paths with no trailing slash", () => {
    for (const path of HOUR_LOG_SURFACES) {
      expect(path.startsWith("/")).toBe(true);
      expect(path.endsWith("/")).toBe(false);
    }
  });

  // Verified rather than assumed: the master + admin schedule grids render
  // cage occupancy (blocked_times / sessions_billing / resources) and read
  // no hour log, so they must NOT be here. Open item 0r described "both
  // schedules" as affected; only the programs schedule actually is.
  it("excludes the cage schedule grids, which read no hour log", () => {
    expect(HOUR_LOG_SURFACES).not.toContain("/master/schedule");
    expect(HOUR_LOG_SURFACES).not.toContain("/admin/schedule");
  });
});
