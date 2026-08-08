// SPEC rate-effective-dating Phase C — the revalidation set for a retroactive
// re-price.
//
// A re-price rewrites the pay SNAPSHOT stamped on hour_logs rows. Per SPEC §8
// that is the whole point: eight read surfaces show that snapshot and none of
// them recompute, so re-stamping propagates everywhere automatically — but
// only once the cached render of each of those surfaces is thrown away. A
// missed path here means a stale money figure sitting on Mark's screen after
// the numbers have already moved underneath it.
//
// ONE list, shared by both public wrappers (the per-coach override card and
// the program Work tab), because two copies of a list like this drift and the
// drift is invisible until someone is looking at the wrong dollar amount.
//
// Derivation: the union of every revalidatePath() in
// src/app/admin/hour-log/actions.ts (the existing writers of this same
// snapshot — approve / reject / edit / delete), plus /admin/reports and
// /admin/hour-log/programs. Deliberately over-broad — /admin/hour-log/held
// and /coach/hour-log/history cannot be reached by a re-price today (the
// engine only touches status='posted' rows) but cost nothing to bust and stay
// correct if that ever changes.
//
// Not included, and why: /admin/coaches and /coach show CAGE-RENTAL balances
// (sessions_billing — money flowing the other direction, explicitly out of
// scope per SPEC §8), not work pay. The callers revalidate /admin/coaches
// anyway, since that page's rate column derives from the override rows a save
// does touch.

import { revalidatePath } from "next/cache";

/** Every surface that renders the work-pay snapshot a re-price rewrites. */
export const WORK_PAY_SURFACES = [
  "/admin",
  "/admin/hour-log",
  "/admin/hour-log/held",
  "/admin/hour-log/programs",
  "/admin/hour-log/schedule",
  "/admin/payments",
  "/admin/records/accountability",
  "/admin/reports",
  "/coach/hour-log",
  "/coach/hour-log/history",
] as const;

export function revalidateWorkPaySurfaces(): void {
  for (const path of WORK_PAY_SURFACES) revalidatePath(path);
}
