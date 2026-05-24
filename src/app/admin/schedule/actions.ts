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

import { requireRole } from "@/lib/authz";
import {
  createBlockInternal,
  deleteBlockInternal,
} from "@/lib/server/block-actions";

export async function createBlock(input: unknown) {
  const session = await requireRole("admin");
  return createBlockInternal(session.user, input);
}

export async function deleteBlock(id: string) {
  const session = await requireRole("admin");
  return deleteBlockInternal(session.user, id);
}
