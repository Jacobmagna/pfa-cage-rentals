"use server";

import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { users } from "@/db/schema";
import { updateUserSchema } from "@/lib/schemas/user";

// First real server action — exists primarily to prove the
// src/lib/schemas/ convention from B1 round-trips through a real
// "use server" file. Will be wired to a profile form later; until
// then it is callable via React Server Actions but has no UI.
//
// Stage B4 will replace the inline auth check with `requireSession()`
// from src/lib/authz.ts. Role changes are deliberately ignored here:
// coaches can rename themselves, only admins can change roles, and
// that admin action lives elsewhere.
export async function updateOwnProfile(input: unknown) {
  const session = await auth();
  if (!session?.user?.id) redirect("/");

  const parsed = updateUserSchema.parse(input);
  if (parsed.name === undefined) return;

  await db
    .update(users)
    .set({ name: parsed.name })
    .where(eq(users.id, session.user.id));
}
