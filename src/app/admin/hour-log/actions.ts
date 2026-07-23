"use server";

// Admin-side public server actions for hour-log entries. Thin authz
// wrappers around the internal logic in
// src/lib/server/hour-log-actions.ts. Every async export in a
// "use server" file is exposed as a public RPC endpoint, so this file
// deliberately ONLY exposes the requireRole("admin")-gated paths.
//
// Revalidation: both actions revalidate /admin/hour-log so the table
// reflects the mutation on the next render (direct RPC callers get the
// right behavior for free, without the form-action wrapper having to
// double-revalidate).

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/authz";
import { acceptTimeEditSchema } from "@/lib/schemas/hour-log";
import {
  resolveCancellationInternal,
  resolveNoShowInternal,
} from "@/lib/server/block-flag-actions";
import {
  acceptNeedsReviewLogInternal,
  approveHeldHourLogInternal,
  deleteHourInternal,
  getHeldLogDetailInternal,
  rejectHeldHourLogInternal,
  rejectNeedsReviewLogInternal,
  resolveHourLogInternal,
  updateHourInternal,
} from "@/lib/server/hour-log-actions";

export async function updateHour(id: string, input: unknown) {
  const session = await requireRole("admin");
  const result = await updateHourInternal(session.user, id, input);
  revalidatePath("/admin/hour-log");
  return result;
}

export async function deleteHour(id: string) {
  const session = await requireRole("admin");
  const result = await deleteHourInternal(session.user, id);
  revalidatePath("/admin/hour-log");
  return result;
}

// Mark an unscheduled hour-log reviewed/acknowledged. Non-destructive: the
// row stays, it just drops off the needs-review queue. Also revalidates
// /admin so the (future) dashboard needs-review card updates too.
export async function resolveUnscheduledHourLog(id: string) {
  const session = await requireRole("admin");
  const result = await resolveHourLogInternal(session.user, id);
  revalidatePath("/admin/hour-log");
  revalidatePath("/admin");
  return result;
}

// Resolve a coach-cancelled block flag (mark reviewed/acknowledged). These
// surface on the Needs-review card, which now renders on BOTH /admin and
// /admin/hour-log, so revalidate both so the card refreshes wherever it was
// resolved from.
export async function resolveCancellation(flagId: string) {
  const session = await requireRole("admin");
  const result = await resolveCancellationInternal(session.user, flagId);
  revalidatePath("/admin");
  revalidatePath("/admin/hour-log");
  return result;
}

// Acknowledge a derived no-show (inserts a stored 'no_show' flag). Same
// surfaces as above — revalidate both /admin and /admin/hour-log.
export async function resolveNoShow(blockId: string, coachId: string) {
  const session = await requireRole("admin");
  const result = await resolveNoShowInternal(session.user, blockId, coachId);
  revalidatePath("/admin");
  revalidatePath("/admin/hour-log");
  return result;
}

// 1b security B — APPROVE a held manual log: flips it to posted (payable +
// counted) and stamps it reviewed so it also leaves the needs-review queue.
// Optionally CORRECTS the log's start/end times in the same action — `edit`
// is parsed via acceptTimeEditSchema (end > start, ≤16h) and pay recomputes
// downstream from the new duration × the snapshotted rate. Revalidates every
// surface that now counts it, the held queue itself, the schedule overlay
// (times may have shifted), and the coach's history (chip flips from "Pending
// approval" to scheduled/unsch).
export async function approveHeldHourLog(
  id: string,
  edit?: { startAt: string; endAt: string },
) {
  const session = await requireRole("admin");
  const parsed = edit ? acceptTimeEditSchema.parse(edit) : undefined;
  const result = await approveHeldHourLogInternal(session.user, id, parsed);
  revalidatePath("/admin/hour-log");
  revalidatePath("/admin/hour-log/held");
  revalidatePath("/admin/hour-log/schedule");
  revalidatePath("/admin/payments");
  revalidatePath("/admin");
  revalidatePath("/admin/records/accountability");
  revalidatePath("/coach/hour-log");
  return result;
}

// 1b security B — read-only detail for the admin held-log "Details +
// edit-then-approve" view. No revalidate (read-only).
export async function getHeldLogDetail(id: string) {
  await requireRole("admin");
  return getHeldLogDetailInternal(id);
}

// 1b security B — REJECT a held manual log: deletes the row (coach must
// re-enter). Same revalidate set as approve.
export async function rejectHeldHourLog(id: string, adminNote?: string) {
  const session = await requireRole("admin");
  const result = await rejectHeldHourLogInternal(session.user, id, adminNote);
  revalidatePath("/admin/hour-log");
  revalidatePath("/admin/hour-log/held");
  revalidatePath("/admin/payments");
  revalidatePath("/admin");
  revalidatePath("/admin/records/accountability");
  revalidatePath("/coach/hour-log");
  return result;
}

// Admin ACCEPT of a needs-review hour log: stays posted (counts) + marked
// reviewed. Idempotent. Optionally CORRECTS the log's start/end times in the
// same action — `edit` is parsed via acceptTimeEditSchema (end > start, ≤16h)
// and pay recomputes downstream from the new duration × the snapshotted rate.
// When an edit changes the times the pay/schedule overlays shift, so we widen
// the revalidate set (payments / accountability / schedule) accordingly.
export async function acceptNeedsReviewLog(
  id: string,
  edit?: { startAt: string; endAt: string },
) {
  const session = await requireRole("admin");
  const parsed = edit ? acceptTimeEditSchema.parse(edit) : undefined;
  const result = await acceptNeedsReviewLogInternal(session.user, id, parsed);
  revalidatePath("/admin/hour-log");
  revalidatePath("/admin");
  revalidatePath("/admin/payments");
  revalidatePath("/admin/records/accountability");
  revalidatePath("/admin/hour-log/schedule");
  revalidatePath("/coach/hour-log");
  return result;
}

// Admin REJECT of a needs-review hour log: flips to 'rejected' (excluded from
// every pay/report/accountability read) but keeps the row + reason so the
// coach sees why. Idempotent. Revalidates every surface that pins posted.
export async function rejectNeedsReviewLog(id: string, reason: string) {
  const session = await requireRole("admin");
  const result = await rejectNeedsReviewLogInternal(session.user, id, reason);
  revalidatePath("/admin/hour-log");
  revalidatePath("/admin");
  revalidatePath("/admin/payments");
  revalidatePath("/admin/records/accountability");
  revalidatePath("/admin/hour-log/schedule");
  revalidatePath("/coach/hour-log");
  return result;
}
