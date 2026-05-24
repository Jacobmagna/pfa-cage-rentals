"use server";

// Admin-side public server actions for blocked times. Thin authz
// wrappers around src/lib/server/block-actions.ts. Every async
// export here is exposed as a public RPC endpoint by Next.js — so
// the file deliberately ONLY exposes the requireRole("admin")-gated
// paths.
//
// Block edit lives in Stage H1 (with the full block-management UI).
// G1 ships create + delete only — the minimum to support "admin
// clicks empty cell on the grid and blocks it for Summer Camp."
//
// Revalidation invariant: every mutating public action revalidates
// /admin/schedule. Form-action wrappers do not double-revalidate.
// Any future direct caller (paint UI, etc.) gets the right behavior.

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/authz";
import {
  createBlockInternal,
  deleteBlockInternal,
  updateBlockInternal,
} from "@/lib/server/block-actions";

export async function createBlock(input: unknown) {
  const session = await requireRole("admin");
  const result = await createBlockInternal(session.user, input);
  revalidatePath("/admin/schedule");
  return result;
}

export async function updateBlock(id: string, input: unknown) {
  const session = await requireRole("admin");
  const result = await updateBlockInternal(session.user, id, input);
  revalidatePath("/admin/schedule");
  return result;
}

export async function deleteBlock(id: string) {
  const session = await requireRole("admin");
  const result = await deleteBlockInternal(session.user, id);
  revalidatePath("/admin/schedule");
  return result;
}
