"use server";

// Admin-side public server actions for programs. Thin authz wrappers
// around the internal logic in src/lib/server/program-actions.ts. Every
// async export in a "use server" file is a public RPC endpoint, so this
// file deliberately ONLY exposes the requireRole("admin")-gated paths.
//
// Each action revalidates /admin/hour-log/programs so the table + badges reflect
// the mutation on the next render.

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/authz";
import {
  createProgramInternal,
  deactivateProgramInternal,
  updateProgramInternal,
} from "@/lib/server/program-actions";

export async function createProgram(input: unknown) {
  const session = await requireRole("admin");
  const result = await createProgramInternal(session.user, input);
  revalidatePath("/admin/hour-log/programs");
  return result;
}

export async function updateProgram(id: string, input: unknown) {
  const session = await requireRole("admin");
  const result = await updateProgramInternal(session.user, id, input);
  revalidatePath("/admin/hour-log/programs");
  return result;
}

export async function deactivateProgram(id: string) {
  const session = await requireRole("admin");
  const result = await deactivateProgramInternal(session.user, id);
  revalidatePath("/admin/hour-log/programs");
  return result;
}
