"use server";

// Admin-side public server action for the Archive sub-tab (DEC-28). Thin
// authz wrapper around restoreAthletesInternal. Every async export in a
// "use server" file is a public RPC endpoint, so this file deliberately
// only exposes the requireRole("admin")-gated path. Revalidates both the
// archive (rows leave) and the roster (they return).

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/authz";
import { restoreAthletesInternal } from "@/lib/server/athlete-actions";

export async function restoreAthletes(ids: string[]) {
  const session = await requireRole("admin");
  const result = await restoreAthletesInternal(session.user, ids);
  revalidatePath("/admin/attendance/archive");
  revalidatePath("/admin/attendance/roster");
  return result;
}
