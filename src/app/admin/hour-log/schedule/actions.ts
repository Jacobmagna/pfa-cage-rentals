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
