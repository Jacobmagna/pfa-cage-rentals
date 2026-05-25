"use server";

// Coach-side public server actions for self-reporting payments to PFA.
// Wraps createPaymentInternal with two guard rails the admin variant
// doesn't need:
//   1. Force coachId = session.user.id — coach can't pay on behalf of
//      another coach (would let a malicious sign-in artificially clear
//      someone else's balance).
//   2. Force status = "pending" — admin auto-confirms their own
//      entries; coach-self-reported entries must wait for Dad's review.
//
// Revalidates both the coach's own page (so the new row appears under
// "Awaiting confirmation") and /admin/payments (so the pending inbox
// updates without a page refresh on Dad's tab).

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/authz";
import { createPaymentInternal } from "@/lib/server/payment-actions";

export async function submitOwnPendingPayment(input: unknown) {
  const session = await requireSession();
  const base =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};
  const safeInput = { ...base, coachId: session.user.id };

  const result = await createPaymentInternal(session.user, safeInput, {
    status: "pending",
  });

  revalidatePath("/coach/payments");
  revalidatePath("/admin/payments");
  return result;
}
