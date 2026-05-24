"use server";

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { requireSession } from "@/lib/authz";
import { updateUserSchema } from "@/lib/schemas/user";

// First real server action — exists primarily to prove the
// src/lib/schemas/ convention from B1 round-trips through a real
// "use server" file. Will be wired to a profile form later; until
// then it is callable via React Server Actions but has no UI.
//
// Role changes are deliberately ignored: coaches can rename
// themselves, only admins can change roles, and that admin action
// lives elsewhere.
export async function updateOwnProfile(input: unknown) {
  const session = await requireSession();
  const parsed = updateUserSchema.parse(input);
  if (parsed.name === undefined) return;

  await db
    .update(users)
    .set({ name: parsed.name })
    .where(eq(users.id, session.user.id));
}
