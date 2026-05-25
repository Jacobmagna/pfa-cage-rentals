"use server";

// useActionState wrapper for the coach's "I just paid" form. Same
// dollars-to-cents + typed-error translation pattern as the admin
// payment form-actions, but doesn't accept coachId from the client —
// the action forces it to session.user.id server-side.

import { ZodError } from "zod";
import { submitOwnPendingPayment } from "./actions";
import { parsePfaInput } from "@/lib/timezone";
import { PAYMENT_METHODS, type PaymentMethod } from "@/lib/schemas/payment";

export type CoachPaymentFormValues = {
  amountDollars: string;
  method: string;
  paidAtDate: string;
  reference: string;
  note: string;
};

export type CoachPaymentActionResult =
  | { ok: true; submittedAt: number }
  | {
      ok: false;
      error: { code: string; message: string };
      values: CoachPaymentFormValues;
    };

function snapshot(formData: FormData): CoachPaymentFormValues {
  return {
    amountDollars: formData.get("amountDollars")?.toString() ?? "",
    method: formData.get("method")?.toString() ?? "",
    paidAtDate: formData.get("paidAtDate")?.toString() ?? "",
    reference: formData.get("reference")?.toString() ?? "",
    note: formData.get("note")?.toString() ?? "",
  };
}

function dollarsToCents(raw: string): number {
  const cleaned = raw.replace(/[$,\s]/g, "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    throw new Error("Amount must be a dollar value like 150 or 150.00");
  }
  const [whole, frac = ""] = cleaned.split(".");
  const fracPadded = (frac + "00").slice(0, 2);
  const cents = parseInt(whole, 10) * 100 + parseInt(fracPadded, 10);
  if (cents <= 0) throw new Error("Amount must be greater than zero");
  return cents;
}

function buildInput(formData: FormData) {
  const methodRaw = formData.get("method")?.toString().trim() ?? "";
  if (!PAYMENT_METHODS.includes(methodRaw as PaymentMethod)) {
    throw new Error("Choose a payment method");
  }
  const amountCents = dollarsToCents(
    formData.get("amountDollars")?.toString() ?? "",
  );
  const paidAtDate = formData.get("paidAtDate")?.toString().trim();
  if (!paidAtDate) throw new Error("Pick a payment date");
  const paidAt = parsePfaInput(paidAtDate, "00:00");
  return {
    amountCents,
    method: methodRaw as PaymentMethod,
    paidAt,
    reference: formData.get("reference")?.toString().trim() || null,
    note: formData.get("note")?.toString().trim() || null,
  };
}

function translate(
  err: unknown,
  values: CoachPaymentFormValues,
): CoachPaymentActionResult {
  if (err instanceof ZodError) {
    const first = err.issues[0];
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: first
          ? `${first.path.join(".")}: ${first.message}`
          : "Invalid input",
      },
      values,
    };
  }
  if (err instanceof Error) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: err.message },
      values,
    };
  }
  throw err;
}

export async function submitOwnPaymentFormAction(
  _prev: CoachPaymentActionResult,
  formData: FormData,
): Promise<CoachPaymentActionResult> {
  const values = snapshot(formData);
  try {
    await submitOwnPendingPayment(buildInput(formData));
    return { ok: true, submittedAt: Date.now() };
  } catch (err) {
    return translate(err, values);
  }
}
