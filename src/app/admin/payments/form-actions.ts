"use server";

// Form-action wrappers for the payments dialog. Mirrors the
// pattern in src/app/admin/sessions/form-actions.ts — translates
// FormData into the internal action's input shape and typed errors
// into a discriminated-union banner shape for useActionState.
//
// Amount handling: the dialog renders a dollars input (e.g. "150.00"),
// but the schema + DB store integer cents. dollarsToCents normalizes
// at the boundary and surfaces a clear validation error on bad input
// rather than silently coercing 0.

import { ZodError } from "zod";
import { recordPayment, updatePayment } from "./actions";
import {
  CoachNotFoundError,
  PaymentNotFoundError,
} from "@/lib/errors";
import { parsePfaInput } from "@/lib/timezone";
import {
  PAYMENT_DIRECTIONS,
  PAYMENT_METHODS,
  type PaymentDirection,
  type PaymentMethod,
} from "@/lib/schemas/payment";

export type SubmittedPaymentValues = {
  coachId: string;
  amountDollars: string;
  method: string;
  direction: string;
  paidAtDate: string;
  reference: string;
  note: string;
};

export type PaymentActionResult =
  | { ok: true }
  | {
      ok: false;
      error: { code: string; message: string };
      values: SubmittedPaymentValues;
    };

function snapshot(formData: FormData): SubmittedPaymentValues {
  return {
    coachId: formData.get("coachId")?.toString() ?? "",
    amountDollars: formData.get("amountDollars")?.toString() ?? "",
    method: formData.get("method")?.toString() ?? "",
    direction: formData.get("direction")?.toString() ?? "",
    paidAtDate: formData.get("paidAtDate")?.toString() ?? "",
    reference: formData.get("reference")?.toString() ?? "",
    note: formData.get("note")?.toString() ?? "",
  };
}

function dollarsToCents(raw: string): number {
  const trimmed = raw.trim();
  // Accept "150", "150.5", "150.50", "$150.00", "1,234.56".
  // Reject anything that doesn't match this shape so a typo doesn't
  // silently become $0.
  const cleaned = trimmed.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    throw new Error("Amount must be a dollar value like 150 or 150.00");
  }
  // Avoid floating-point surprises: split on the decimal point and
  // pad to exactly 2 digits before parseInt. "150.5" → 15050,
  // "150.50" → 15050, "150" → 15000.
  const [whole, frac = ""] = cleaned.split(".");
  const fracPadded = (frac + "00").slice(0, 2);
  const cents = parseInt(whole, 10) * 100 + parseInt(fracPadded, 10);
  if (cents <= 0) {
    throw new Error("Amount must be greater than zero");
  }
  return cents;
}

function buildInput(formData: FormData) {
  const methodRaw = formData.get("method")?.toString().trim() ?? "";
  if (!PAYMENT_METHODS.includes(methodRaw as PaymentMethod)) {
    throw new Error("Choose a payment method");
  }
  // Direction defaults to coach_to_pfa (cage rental) when the form omits it,
  // matching the schema default + the historical implicit direction.
  const directionRaw =
    formData.get("direction")?.toString().trim() || "coach_to_pfa";
  if (!PAYMENT_DIRECTIONS.includes(directionRaw as PaymentDirection)) {
    throw new Error("Choose a payment direction");
  }
  const amountStr = formData.get("amountDollars")?.toString() ?? "";
  const amountCents = dollarsToCents(amountStr);

  const paidAtDate = formData.get("paidAtDate")?.toString().trim();
  if (!paidAtDate) {
    throw new Error("Pick a payment date");
  }
  // Store as midnight PFA wall-clock — same convention as
  // session start times when no time-of-day was supplied.
  const paidAt = parsePfaInput(paidAtDate, "00:00");

  return {
    coachId: formData.get("coachId")?.toString() ?? "",
    amountCents,
    method: methodRaw as PaymentMethod,
    direction: directionRaw as PaymentDirection,
    paidAt,
    reference: formData.get("reference")?.toString().trim() || null,
    note: formData.get("note")?.toString().trim() || null,
  };
}

function translateError(
  err: unknown,
  values: SubmittedPaymentValues,
): PaymentActionResult {
  if (err instanceof CoachNotFoundError || err instanceof PaymentNotFoundError) {
    return { ok: false, error: { code: err.code, message: err.message }, values };
  }
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

export async function recordPaymentFormAction(
  _prev: PaymentActionResult,
  formData: FormData,
): Promise<PaymentActionResult> {
  const values = snapshot(formData);
  try {
    await recordPayment(buildInput(formData));
    return { ok: true };
  } catch (err) {
    return translateError(err, values);
  }
}

export async function updatePaymentFormAction(
  _prev: PaymentActionResult,
  formData: FormData,
): Promise<PaymentActionResult> {
  const values = snapshot(formData);
  const id = formData.get("id")?.toString();
  if (!id) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "Missing payment id" },
      values,
    };
  }
  try {
    await updatePayment(id, buildInput(formData));
    return { ok: true };
  } catch (err) {
    return translateError(err, values);
  }
}
