"use server";

// Public server actions for the /admin/coaches list. Thin authz
// wrappers around src/lib/server/user-actions.ts — direct exposure
// of the internals would let anyone forge admin identity (every
// async export from a "use server" file is a public RPC endpoint).

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/authz";
import { mergeSyntheticCoachInternal } from "@/lib/server/user-actions";

export async function mergeSyntheticCoach(
  sourceId: string,
  targetId: string,
): Promise<{ movedSessions: number }> {
  const session = await requireRole("admin");
  const result = await mergeSyntheticCoachInternal(
    session.user,
    sourceId,
    targetId,
  );
  // Every active-coach surface needs to drop the source + re-attribute
  // the moved sessions.
  revalidatePath("/admin/coaches");
  revalidatePath(`/admin/coaches/${sourceId}`);
  revalidatePath(`/admin/coaches/${targetId}`);
  revalidatePath("/admin/sessions");
  revalidatePath("/admin/schedule");
  revalidatePath("/admin/reports");
  return result;
}
