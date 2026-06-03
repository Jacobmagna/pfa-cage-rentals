"use server";

// Admin-side public server actions for program schedule blocks. Thin
// authz wrappers around src/lib/server/program-schedule-actions.ts.
// Every async export here is exposed as a public RPC endpoint by
// Next.js — so the file deliberately ONLY exposes the
// requireRole("admin")-gated paths.
//
// Revalidation invariant: every mutating public action revalidates
// /admin/hour-log/schedule. Form-action wrappers do not double-
// revalidate.

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/authz";
import {
  createProgramScheduleBlockInternal,
  deleteProgramScheduleBlockInternal,
  updateProgramScheduleBlockInternal,
} from "@/lib/server/program-schedule-actions";
import {
  cancelSeriesOccurrenceInternal,
  createProgramScheduleSeriesInternal,
  editProgramScheduleSeriesInternal,
} from "@/lib/server/program-schedule-series-actions";

export async function createProgramScheduleBlock(input: unknown) {
  const session = await requireRole("admin");
  const result = await createProgramScheduleBlockInternal(session.user, input);
  revalidatePath("/admin/hour-log/schedule");
  return result;
}

export async function updateProgramScheduleBlock(id: string, input: unknown) {
  const session = await requireRole("admin");
  const result = await updateProgramScheduleBlockInternal(
    session.user,
    id,
    input,
  );
  revalidatePath("/admin/hour-log/schedule");
  return result;
}

export async function deleteProgramScheduleBlock(id: string) {
  const session = await requireRole("admin");
  await deleteProgramScheduleBlockInternal(session.user, id);
  revalidatePath("/admin/hour-log/schedule");
}

// RECUR-a: recurring-series public actions. Each materializes / mutates
// program_schedule_blocks under the hood, so all three revalidate the
// schedule route.
export async function createProgramScheduleSeries(input: unknown) {
  const session = await requireRole("admin");
  const result = await createProgramScheduleSeriesInternal(session.user, input);
  revalidatePath("/admin/hour-log/schedule");
  return result;
}

export async function editProgramScheduleSeries(
  seriesId: string,
  input: unknown,
) {
  const session = await requireRole("admin");
  const result = await editProgramScheduleSeriesInternal(
    session.user,
    seriesId,
    input,
  );
  revalidatePath("/admin/hour-log/schedule");
  return result;
}

export async function cancelSeriesOccurrence(blockId: string) {
  const session = await requireRole("admin");
  const result = await cancelSeriesOccurrenceInternal(session.user, blockId);
  revalidatePath("/admin/hour-log/schedule");
  return result;
}
