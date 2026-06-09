"use server";

// Public server actions for the /admin/coaches list. Thin authz
// wrappers around src/lib/server/user-actions.ts — direct exposure
// of the internals would let anyone forge admin identity (every
// async export from a "use server" file is a public RPC endpoint).

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { requireRole } from "@/lib/authz";
import {
  addCoachInternal,
  CoachEmailTakenError,
  mergeSyntheticCoachInternal,
  restoreCoachInternal,
} from "@/lib/server/user-actions";

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

// Restore a soft-deleted (archived) coach back to the active roster.
// Mirrors restoreAthletes — thin authz wrapper, revalidates both the
// archive view (the row leaves) and the active list + active-coach
// surfaces (the coach returns). The internal is a no-op for already-
// active / unknown ids, so a stray click can't error.
export async function restoreCoach(coachId: string) {
  const session = await requireRole("admin");
  await restoreCoachInternal(session.user, coachId);
  revalidatePath("/admin/coaches/archive");
  revalidatePath("/admin/coaches");
  revalidatePath("/admin/sessions");
  revalidatePath("/admin/schedule");
  revalidatePath("/admin/reports");
  revalidatePath("/admin/audit");
}

// ---- Add coach (invite path) --------------------------------------------
//
// Public, requireRole-gated server action behind the admin "Add coach"
// form. Resolves the actor server-side (never trusting client identity),
// delegates the DB work to addCoachInternal, then reshapes ZodError /
// CoachEmailTakenError into the useActionState Result the form renders.
// Lives here (a "use server" route file) rather than in user-actions.ts
// because an inline server action can't be exported from a module a
// Client Component imports, and user-actions.ts must NOT be a blanket
// "use server" module (that would expose every internal as an RPC
// endpoint).

export type AddCoachResult =
  | { ok: true; mode: "created" | "restored"; addedAt: number }
  | {
      ok: false;
      error: { code: string; message: string };
      values: { name: string; email: string };
    };

export async function addCoachAction(
  _prev: AddCoachResult,
  formData: FormData,
): Promise<AddCoachResult> {
  const session = await requireRole("admin");

  const values = {
    name: formData.get("name")?.toString() ?? "",
    email: formData.get("email")?.toString() ?? "",
  };

  try {
    const { mode } = await addCoachInternal(session.user, values);
    revalidatePath("/admin/coaches");
    return { ok: true, mode, addedAt: Date.now() };
  } catch (err) {
    if (err instanceof ZodError) {
      const first = err.issues[0];
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: first?.message ?? "Invalid input",
        },
        values,
      };
    }
    if (err instanceof CoachEmailTakenError) {
      return {
        ok: false,
        error: { code: err.code, message: err.message },
        values,
      };
    }
    // Unknown — let Next.js error boundary + Sentry handle it.
    throw err;
  }
}
