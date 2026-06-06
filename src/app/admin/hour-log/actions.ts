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
import {
  deleteHourInternal,
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
