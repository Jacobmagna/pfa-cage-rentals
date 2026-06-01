"use server";

// Coach-side public server action for attendance. Thin authz wrapper
// around the internal logic in src/lib/server/attendance-actions.ts.
//
// Every async export in a "use server" file is exposed as a public RPC
// endpoint. This entry point is gated by requireSession(), and
// submitAttendanceInternal stamps createdBy/recordedBy from the authed
// actor (a client-supplied actor is never read) and runs
// assertCoachCanAccessProgram, so a coach can't take attendance for a
// program they aren't assigned to.
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
