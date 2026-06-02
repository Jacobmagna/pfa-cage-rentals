"use server";

// Coach-side public server action for the hour log. Thin authz
// wrapper around the internal logic in
// src/lib/server/hour-log-actions.ts.
//
// Every async export in a "use server" file is exposed as a public
// RPC endpoint. This entry point is gated by requireSession(), and
// logHourInternal stamps coachId/createdBy from the authed actor — a
// client-supplied coachId is never read, so a coach cannot log hours
// for another coach. Any coach may log against any active program
// (DEC-29); the internal fn only enforces program-exists + active.
//
// revalidatePath at the end so any direct RPC caller (not just the
// form-action wrapper) gets fresh data on /coach/hour-log and /coach.

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/authz";
import { logHourInternal } from "@/lib/server/hour-log-actions";

export async function logOwnHour(input: unknown) {
  const session = await requireSession();
  const result = await logHourInternal(session.user, input);
  revalidatePath("/coach/hour-log");
  revalidatePath("/coach");
  return result;
}
