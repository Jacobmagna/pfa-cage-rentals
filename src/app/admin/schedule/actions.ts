"use server";

// Admin-side public server actions for blocked times. Thin authz
// wrappers around src/lib/server/block-actions.ts. Every async
// export here is exposed as a public RPC endpoint by Next.js — so
// the file deliberately ONLY exposes the requireScheduleAccess-gated
// paths (admin or schedule manager).
//
// Block edit lives in Stage H1 (with the full block-management UI).
// G1 ships create + delete only — the minimum to support "admin
// clicks empty cell on the grid and blocks it for Summer Camp."
//
// Revalidation invariant: every mutating public action revalidates
// /admin/schedule. Form-action wrappers do not double-revalidate.
// Any future direct caller (paint UI, etc.) gets the right behavior.

import { revalidatePath } from "next/cache";
import { requireScheduleAccess } from "@/lib/authz";
import {
  createBlockInternal,
  deleteBlockInternal,
  updateBlockInternal,
} from "@/lib/server/block-actions";
import {
  cancelBlockSeriesOccurrenceInternal,
  createBlocksBatchInternal,
  createBlockSeriesInternal,
  deleteBlockSeriesInternal,
  editBlockSeriesInternal,
} from "@/lib/server/block-series-actions";

// Blocks surface on the admin cage grid, the master schedule grid, and both
// home dashboards — revalidate all of them after any block mutation.
function revalidateScheduleSurfaces() {
  revalidatePath("/admin/schedule");
  revalidatePath("/master/schedule");
  revalidatePath("/admin");
  revalidatePath("/master");
}

export async function createBlock(input: unknown) {
  const session = await requireScheduleAccess();
  const result = await createBlockInternal(session.user, input);
  revalidatePath("/admin/schedule");
  return result;
}

// BLOCK-RECUR: create a RECURRING blocked-time series. Returns a skip-and-
// continue summary (created count + skipped-rental report) for the dialog.
export async function createBlockSeries(input: unknown) {
  const session = await requireScheduleAccess();
  const result = await createBlockSeriesInternal(session.user, input);
  revalidateScheduleSurfaces();
  return result;
}

// MULTI-CAGE: create a ONE-OFF block over one OR MANY resources at once, with
// skip-and-continue conflict handling. Returns a batch summary for the dialog.
export async function createBlocksBatch(input: unknown) {
  const session = await requireScheduleAccess();
  const result = await createBlocksBatchInternal(session.user, input);
  revalidateScheduleSurfaces();
  return result;
}

// BLOCK-RECUR: edit a recurring block series (regenerates FUTURE occurrences).
export async function editBlockSeries(seriesId: string, input: unknown) {
  const session = await requireScheduleAccess();
  const result = await editBlockSeriesInternal(session.user, seriesId, input);
  revalidateScheduleSurfaces();
  return result;
}

// BLOCK-RECUR: cancel a single occurrence of a recurring block series
// (deletes that block + records the date in the series' skipDates).
export async function cancelBlockOccurrence(blockId: string) {
  const session = await requireScheduleAccess();
  const result = await cancelBlockSeriesOccurrenceInternal(
    session.user,
    blockId,
  );
  revalidateScheduleSurfaces();
  return result;
}

// BLOCK-RECUR: delete an entire recurring block series (all occurrences).
export async function deleteBlockSeries(seriesId: string) {
  const session = await requireScheduleAccess();
  const result = await deleteBlockSeriesInternal(session.user, seriesId);
  revalidateScheduleSurfaces();
  return result;
}

export async function updateBlock(id: string, input: unknown) {
  const session = await requireScheduleAccess();
  const result = await updateBlockInternal(session.user, id, input);
  revalidatePath("/admin/schedule");
  return result;
}

export async function deleteBlock(id: string) {
  const session = await requireScheduleAccess();
  const result = await deleteBlockInternal(session.user, id);
  revalidatePath("/admin/schedule");
  return result;
}
