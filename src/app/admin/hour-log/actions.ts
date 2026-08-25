"use server";

// Admin-side public server actions for hour-log entries. Thin authz
// wrappers around the internal logic in
// src/lib/server/hour-log-actions.ts. Every async export in a
// "use server" file is exposed as a public RPC endpoint, so this file
// deliberately ONLY exposes the requireRole("admin")-gated paths.
//
// 0r(2) — REVALIDATION. Every action here changes something that at least
// one OTHER route renders, so they all revalidate the single shared list in
// @/lib/hour-log-surfaces rather than each maintaining its own.
//
// This used to be per-action and hand-maintained, and it had drifted:
// `updateHour` and `deleteHour` revalidated ONLY "/admin/hour-log", while
// the resolvers three functions below them already revalidated "/admin" as
// well. `revalidatePath` does not cascade to nested routes, so editing or
// deleting a log never told the schedule overlay, the dashboard, the
// accountability scorecard or the reports tab — every one of which derives
// its output from hour_logs. The list is now stated once, so the next
// surface that reads a log cannot be missed by a mutation that predates it.

import { revalidatePath } from "next/cache";
import { HOUR_LOG_SURFACES } from "@/lib/hour-log-surfaces";
import { requireRole } from "@/lib/authz";
import { acceptTimeEditSchema } from "@/lib/schemas/hour-log";
import {
  resolveCancellationInternal,
  resolveNoShowInternal,
} from "@/lib/server/block-flag-actions";
import {
  matchBlockToLoggedTimesInternal,
  reassignBlockToLoggedCoachInternal,
} from "@/lib/server/block-recon-actions";
import {
  acceptNeedsReviewLogInternal,
  approveHeldHourLogInternal,
  deleteHourInternal,
  getHeldLogDetailInternal,
  logHourForCoachInternal,
  rejectHeldHourLogInternal,
  rejectNeedsReviewLogInternal,
  resolveHourLogInternal,
  updateHourInternal,
} from "@/lib/server/hour-log-actions";

// Not exported: a "use server" module may only export async functions, and
// every such export becomes a public RPC endpoint. Local by necessity.
function revalidateHourLogSurfaces() {
  for (const path of HOUR_LOG_SURFACES) revalidatePath(path);
}

// 🔴 AN ADMIN RECORDS HOURS FOR A COACH. The one path in the product that can
// create an hour log for somebody other than the signed-in user.
//
// `requireRole("admin")` and NEVER `requireScheduleAccess()`. The schedule
// role (`schedule_admin`) is an additive flag on a COACH that grants the
// master schedule tab and nothing else — it is documented as never reaching
// money, pay, reports, roster, audit, import or settings. This writes a
// payable row. Gating it on the wider check would hand payroll creation to
// every schedule manager, which is the exact boundary the role exists to draw.
export async function logHourForCoach(input: unknown) {
  const session = await requireRole("admin");
  const result = await logHourForCoachInternal(session.user, input);
  revalidateHourLogSurfaces();
  return result;
}

export async function updateHour(id: string, input: unknown) {
  const session = await requireRole("admin");
  const result = await updateHourInternal(session.user, id, input);
  revalidateHourLogSurfaces();
  return result;
}

export async function deleteHour(id: string) {
  const session = await requireRole("admin");
  const result = await deleteHourInternal(session.user, id);
  revalidateHourLogSurfaces();
  return result;
}

// Mark an unscheduled hour-log reviewed/acknowledged. Non-destructive: the
// row stays, it just drops off the needs-review queue.
export async function resolveUnscheduledHourLog(id: string) {
  const session = await requireRole("admin");
  const result = await resolveHourLogInternal(session.user, id);
  revalidateHourLogSurfaces();
  return result;
}

// Resolve a coach-cancelled block flag (mark reviewed/acknowledged). These
// surface on the Needs-review card, which renders on BOTH /admin and
// /admin/hour-log.
export async function resolveCancellation(flagId: string) {
  const session = await requireRole("admin");
  const result = await resolveCancellationInternal(session.user, flagId);
  revalidateHourLogSurfaces();
  return result;
}

// Acknowledge a derived no-show (inserts a stored 'no_show' flag).
export async function resolveNoShow(blockId: string, coachId: string) {
  const session = await requireRole("admin");
  const result = await resolveNoShowInternal(session.user, blockId, coachId);
  revalidateHourLogSurfaces();
  return result;
}

// 0r(1) — SUBSTITUTE REASSIGN: move one block occurrence from the scheduled
// coach who did not work it to the coach who actually logged it, clearing a
// `wrong_coach` state that no action could previously resolve. The internal
// action refuses unless the recipient already has a posted log covering the
// block, so this can never invent a shift for a coach who did not work.
//
// Reconciliation is derived, so the red clears on the next render with no
// stored state — which is exactly why the revalidate set matters here.
export async function reassignBlockToLoggedCoach(input: {
  blockId: string;
  fromCoachId: string;
  toCoachId: string;
}) {
  const session = await requireRole("admin");
  const result = await reassignBlockToLoggedCoachInternal(session.user, input);
  revalidateHourLogSurfaces();
  return result;
}

// 0r(4) — MATCH THE SCHEDULE TO WHAT HAPPENED: move a `wrong_time` block's
// window onto the times the scheduled coach actually logged. The internal
// action re-derives the target window by running the reconciliation engine
// server-side, so no times cross the wire and a stale render fails the guard
// rather than moving a block to a window nobody worked.
export async function matchBlockToLoggedTimes(input: {
  blockId: string;
  coachId: string;
}) {
  const session = await requireRole("admin");
  const result = await matchBlockToLoggedTimesInternal(session.user, input);
  revalidateHourLogSurfaces();
  // The block itself moved, so the two CAGE schedule grids (which render the
  // linked blocked_times this action moves with it) must refresh too — they
  // are deliberately NOT in HOUR_LOG_SURFACES because no hour log reaches
  // them, but a block move does.
  revalidatePath("/admin/schedule");
  revalidatePath("/master/schedule");
  revalidatePath("/coach/schedule");
  return result;
}

// 1b security B — APPROVE a held manual log: flips it to posted (payable +
// counted) and stamps it reviewed so it also leaves the needs-review queue.
// Optionally CORRECTS the log's start/end times in the same action — `edit`
// is parsed via acceptTimeEditSchema (end > start, ≤16h) and pay recomputes
// downstream from the new duration × the snapshotted rate.
export async function approveHeldHourLog(
  id: string,
  edit?: { startAt: string; endAt: string },
) {
  const session = await requireRole("admin");
  const parsed = edit ? acceptTimeEditSchema.parse(edit) : undefined;
  const result = await approveHeldHourLogInternal(session.user, id, parsed);
  revalidateHourLogSurfaces();
  return result;
}

// 1b security B — read-only detail for the admin held-log "Details +
// edit-then-approve" view. No revalidate (read-only).
export async function getHeldLogDetail(id: string) {
  await requireRole("admin");
  return getHeldLogDetailInternal(id);
}

// 1b security B — REJECT a held manual log: deletes the row (coach must
// re-enter).
export async function rejectHeldHourLog(id: string, adminNote?: string) {
  const session = await requireRole("admin");
  const result = await rejectHeldHourLogInternal(session.user, id, adminNote);
  revalidateHourLogSurfaces();
  return result;
}

// Admin ACCEPT of a needs-review hour log: stays posted (counts) + marked
// reviewed. Idempotent. Optionally CORRECTS the log's start/end times in the
// same action — `edit` is parsed via acceptTimeEditSchema (end > start, ≤16h)
// and pay recomputes downstream from the new duration × the snapshotted rate.
export async function acceptNeedsReviewLog(
  id: string,
  edit?: { startAt: string; endAt: string },
) {
  const session = await requireRole("admin");
  const parsed = edit ? acceptTimeEditSchema.parse(edit) : undefined;
  const result = await acceptNeedsReviewLogInternal(session.user, id, parsed);
  revalidateHourLogSurfaces();
  return result;
}

// Admin REJECT of a needs-review hour log: flips to 'rejected' (excluded from
// every pay/report/accountability read) but keeps the row + reason so the
// coach sees why. Idempotent.
export async function rejectNeedsReviewLog(id: string, reason: string) {
  const session = await requireRole("admin");
  const result = await rejectNeedsReviewLogInternal(session.user, id, reason);
  revalidateHourLogSurfaces();
  return result;
}
