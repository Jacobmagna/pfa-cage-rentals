"use server";

// useActionState wrappers for the QA2 coach-detail cards:
//   #8 Notes card        → updateCoachNotesFormAction
//   #6 Work-pay-mode card → updateCoachPayModeFormAction
//
// Same pattern as the handles / rate-override form-actions: snapshot the
// typed values so a Zod failure remounts the form with what the admin had
// in flight, instead of blanking the inputs. The dollar→cents conversion
// for the per-session amount mirrors dollarsToCents in form-actions.ts.

import { ZodError } from "zod";
import { updateCoachNotes, updateCoachPaySettings } from "./actions";
import { CoachNotFoundError } from "@/lib/errors";
import type { CoachPayMode } from "@/db/schema";

// ---------------------------------------------------------------------
// #8 Notes
// ---------------------------------------------------------------------

export type NotesFormValues = { notes: string };

export type NotesActionResult =
  | { ok: true }
  | {
      ok: false;
      error: { code: string; message: string };
      values: NotesFormValues;
    };

function translateNotes(
  err: unknown,
  values: NotesFormValues,
): NotesActionResult {
  if (err instanceof CoachNotFoundError) {
    return { ok: false, error: { code: err.code, message: err.message }, values };
  }
  if (err instanceof ZodError) {
    const first = err.issues[0];
    return {
      ok: false,
      error: { code: "VALIDATION", message: first?.message ?? "Invalid input" },
      values,
    };
  }
  throw err;
}

export async function updateCoachNotesFormAction(
  _prev: NotesActionResult,
  formData: FormData,
): Promise<NotesActionResult> {
  const values: NotesFormValues = {
    notes: formData.get("notes")?.toString() ?? "",
  };
  const coachId = formData.get("coachId")?.toString();
  if (!coachId) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "Missing coach id" },
      values,
    };
  }
  try {
    await updateCoachNotes({ coachId, notes: values.notes });
    return { ok: true };
  } catch (err) {
    return translateNotes(err, values);
  }
}

// ---------------------------------------------------------------------
// #6 Work pay mode
// ---------------------------------------------------------------------

export type PayModeFormValues = {
  payMode: CoachPayMode;
  /** As the user typed it (dollars, "120.00"). Echoed back on error. */
  perSessionDollars: string;
};

export type PayModeActionResult =
  | { ok: true }
  | {
      ok: false;
      error: { code: string; message: string };
      values: PayModeFormValues;
    };

/**
 * Parses a user-typed dollar string into cents. Accepts "120", "120.0",
 * "120.50". Rejects negatives, non-numbers, and >2-decimal precision —
 * matches dollarsToCents in form-actions.ts.
 */
function dollarsToCents(input: string): number {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Per-session amount is required");
  const cleaned = trimmed.replace(/^\$/, "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    throw new Error(
      "Amount must be a positive dollar amount (e.g. 120 or 120.50)",
    );
  }
  const asFloat = Number(cleaned);
  if (!Number.isFinite(asFloat) || asFloat <= 0) {
    throw new Error("Amount must be greater than $0");
  }
  return Math.round(asFloat * 100);
}

function translatePayMode(
  err: unknown,
  values: PayModeFormValues,
): PayModeActionResult {
  if (err instanceof CoachNotFoundError) {
    return { ok: false, error: { code: err.code, message: err.message }, values };
  }
  if (err instanceof ZodError) {
    const first = err.issues[0];
    return {
      ok: false,
      error: { code: "VALIDATION", message: first?.message ?? "Invalid input" },
      values,
    };
  }
  if (err instanceof Error) {
    return { ok: false, error: { code: "INPUT", message: err.message }, values };
  }
  throw err;
}

export async function updateCoachPayModeFormAction(
  _prev: PayModeActionResult,
  formData: FormData,
): Promise<PayModeActionResult> {
  const rawMode = formData.get("payMode")?.toString();
  const payMode: CoachPayMode = rawMode === "per_session" ? "per_session" : "hourly";
  const values: PayModeFormValues = {
    payMode,
    perSessionDollars: formData.get("perSessionDollars")?.toString() ?? "",
  };
  const coachId = formData.get("coachId")?.toString();
  if (!coachId) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "Missing coach id" },
      values,
    };
  }
  try {
    // Only convert the dollar amount when paying per session; for hourly
    // the amount is irrelevant and may be left blank.
    const perSessionRateCents =
      payMode === "per_session" ? dollarsToCents(values.perSessionDollars) : null;
    await updateCoachPaySettings({ coachId, payMode, perSessionRateCents });
    return { ok: true };
  } catch (err) {
    return translatePayMode(err, values);
  }
}
