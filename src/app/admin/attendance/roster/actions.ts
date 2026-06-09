"use server";

// Admin-side public server actions for the roster. Thin authz wrappers
// around the internal logic in src/lib/server/athlete-actions.ts. Every
// async export in a "use server" file is a public RPC endpoint, so this
// file deliberately ONLY exposes the requireRole("admin")-gated paths.
//
// Each action revalidates /admin/attendance/roster so the table + badges
// reflect the mutation on the next render.

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/authz";
import {
  archiveAthletesInternal,
  assignAthletesToProgramInternal,
  createAthleteInternal,
  deleteAthleteInternal,
  dismissDuplicateInternal,
  mergeAthletesInternal,
  updateAthleteInternal,
} from "@/lib/server/athlete-actions";

export async function addAthlete(input: unknown) {
  const session = await requireRole("admin");
  const result = await createAthleteInternal(session.user, input);
  revalidatePath("/admin/attendance/roster");
  return result;
}

export async function updateAthlete(id: string, input: unknown) {
  const session = await requireRole("admin");
  const result = await updateAthleteInternal(session.user, id, input);
  revalidatePath("/admin/attendance/roster");
  return result;
}

export async function deleteAthlete(id: string) {
  const session = await requireRole("admin");
  const result = await deleteAthleteInternal(session.user, id);
  revalidatePath("/admin/attendance/roster");
  return result;
}

export async function assignAthletes(input: unknown) {
  const session = await requireRole("admin");
  const result = await assignAthletesToProgramInternal(session.user, input);
  revalidatePath("/admin/attendance/roster");
  return result;
}

// Bulk-archive the selected athletes (DEC-28). Revalidates both the
// roster (they drop off) and the archive tab (they appear there).
export async function archiveAthletes(ids: string[]) {
  const session = await requireRole("admin");
  const result = await archiveAthletesInternal(session.user, ids);
  revalidatePath("/admin/attendance/roster");
  revalidatePath("/admin/attendance/archive");
  return result;
}

// Merge duplicate athletes into a single survivor (#17 roster dedup).
// Re-points attendance + enrollments off each source onto the survivor
// then deletes the sources. Revalidates every surface that lists athletes
// or rolls up their attendance/reporting.
export async function mergeAthletesAction(
  survivorId: string,
  sourceIds: string[],
) {
  const session = await requireRole("admin");
  const result = await mergeAthletesInternal(session.user, {
    survivorId,
    sourceIds,
  });
  revalidatePath("/admin/attendance/roster");
  revalidatePath("/admin/attendance/roster/duplicates");
  revalidatePath("/admin/attendance");
  revalidatePath("/admin/reports");
  return result;
}

// Persist a "not duplicates" decision so the pair never re-surfaces (#17).
export async function dismissDuplicateAction(
  athleteAId: string,
  athleteBId: string,
) {
  const session = await requireRole("admin");
  const result = await dismissDuplicateInternal(session.user, {
    athleteAId,
    athleteBId,
  });
  revalidatePath("/admin/attendance/roster/duplicates");
  revalidatePath("/admin/attendance/roster");
  return result;
}
