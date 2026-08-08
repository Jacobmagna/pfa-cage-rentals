"use server";

// Admin-side public server actions for the coach-payments ledger.
// Thin authz wrappers around src/lib/server/payment-actions.ts.
// Every export here is gated by requireRole("admin") and exposed
// as an RPC endpoint — internal helpers must NOT be re-exported.
//
// Revalidation: /admin/payments + the touched coach's detail page.

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/authz";
import {
  confirmPaymentInternal,
  createPaymentInternal,
  deletePaymentInternal,
  updatePaymentInternal,
} from "@/lib/server/payment-actions";

function revalidatePaymentSurfaces(coachId?: string) {
  revalidatePath("/admin/payments");
  // The Reports "Payments" tab renders the audit timeline for these same
  // payments and can EDIT them through this very action (reports-tabs
  // SPEC §3). Without this, an edit made from that tab would append its
  // audit event and then re-render the page from cache — showing the old
  // values and no new event, i.e. looking like the save silently failed.
  revalidatePath("/admin/reports");
  if (coachId) revalidatePath(`/admin/coaches/${coachId}`);
}

export async function recordPayment(input: unknown) {
  const session = await requireRole("admin");
  const result = await createPaymentInternal(session.user, input);
  revalidatePaymentSurfaces(result.coachId);
  return result;
}

export async function updatePayment(id: string, input: unknown) {
  const session = await requireRole("admin");
  const result = await updatePaymentInternal(session.user, id, input);
  revalidatePaymentSurfaces(result.coachId);
  return result;
}

export async function deletePayment(id: string) {
  const session = await requireRole("admin");
  await deletePaymentInternal(session.user, id);
  revalidatePaymentSurfaces();
}

export async function confirmPayment(id: string) {
  const session = await requireRole("admin");
  const result = await confirmPaymentInternal(session.user, id);
  revalidatePaymentSurfaces(result.coachId);
  return result;
}
