"use server";

// Coach-side public server action for attendance. Thin authz wrapper
// around the internal logic in src/lib/server/attendance-actions.ts.
//
// Every async export in a "use server" file is exposed as a public RPC
// endpoint. This entry point is gated by requireSession(), and
// submitAttendanceInternal stamps createdBy/recordedBy from the authed
// actor (a client-supplied actor is never read). Any coach may take
// attendance for any active program (DEC-29); the internal fn only
// enforces program-exists + active + a non-empty roster.
//
// revalidatePath at the end so any direct RPC caller (not just the
// form-action wrapper) gets fresh data on /coach/attendance and /coach.

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/authz";
import { submitAttendanceInternal } from "@/lib/server/attendance-actions";

export async function submitOwnAttendance(input: unknown) {
  const session = await requireSession();
  const result = await submitAttendanceInternal(session.user, input);
  revalidatePath("/coach/attendance");
  revalidatePath("/coach");
  return result;
}
