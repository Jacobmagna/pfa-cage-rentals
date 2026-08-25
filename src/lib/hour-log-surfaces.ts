// 0r(2) — the ONE list of routes that render hour-log-derived state.
//
// WHY THIS MODULE EXISTS. `deleteHour` and `updateHour` revalidated only
// `/admin/hour-log`, while the two resolvers directly beneath them in the
// same file revalidated `/admin` as well. `revalidatePath` does NOT cascade
// to nested routes, so editing or deleting a log left the schedule overlay,
// the dashboard, the accountability scorecard and the reports tab showing
// figures the database no longer agreed with. It was an oversight rather
// than a decision — the wider pattern already existed three functions away.
//
// The durable fix is not "add the missing paths to those two functions" —
// that leaves the next surface just as easy to miss. It is to name the set
// ONCE, here, and have every hour-log mutation revalidate all of it. Adding
// a new surface that reads hour logs means adding one line to this array,
// and every mutation picks it up.
//
// PURE ON PURPOSE: no `next/cache` import, so this list is unit-testable.
// `revalidatePath` may only be called from a request scope, and the file
// that calls it is `"use server"` — every async export there becomes a
// public RPC endpoint, so it is unreachable from a unit test. Same
// constraint that produced `@/lib/program-stipend-field` and
// `@/lib/rate-input`.
//
// 📌 NOT included, verified rather than assumed:
//   • `/master/schedule` and `/admin/schedule` render CAGE occupancy
//     (blocked_times / sessions_billing / resources). Neither reads an
//     hour log, so neither can go stale from one. (Open item 0r described
//     "both schedules" as affected; the master schedule is not.)
//   • `/coach/schedule` renders blocks, not logs.

/**
 * Every route whose rendered output is derived from `hour_logs`, and what
 * each one shows. Order is presentation-only.
 */
export const HOUR_LOG_SURFACES = [
  // Dashboard: the WORK strip (reconciled against the schedule) + the
  // month money cards.
  "/admin",
  // The hour-log table itself.
  "/admin/hour-log",
  // The held-for-approval queue (loadHeldHourLogs).
  "/admin/hour-log/held",
  // The programs-schedule grid — `reconcileBlocks` recomputes block status
  // from the logs on every render, so a deleted log changes every colour.
  "/admin/hour-log/schedule",
  // Coach pay + the ledger.
  "/admin/payments",
  // The reports tabs, incl. Work and Statements — the money surfaces.
  // 🔴 NOTHING in the hour-log path revalidated this before 0r.
  "/admin/reports",
  // The accountability scorecard (accountability-data.ts reads hour_logs).
  "/admin/records/accountability",
  // The coach's own history + the confirm list (a deleted log makes its
  // block confirmable again, so this one is load-bearing, not cosmetic).
  "/coach/hour-log",
] as const;

export type HourLogSurface = (typeof HOUR_LOG_SURFACES)[number];
