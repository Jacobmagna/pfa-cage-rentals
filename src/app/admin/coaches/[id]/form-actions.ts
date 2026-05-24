"use server";

// useActionState wrapper for the Save form on each rate-override
// row. Translates FormData (rate in dollars as a string) → cents
// integer, and typed errors → discriminated-union result so the
// banner UI doesn't need try/catch.
//
// Remove uses a plain server action; the row's UI is just a button +
// confirm() — no useActionState needed.

import { ZodError } from "zod";
import { upsertRateOverride } from "./actions";

export type RateOverrideFormValues = {
  coachId: string;
  resourceType: string;
  /** As the user typed it (dollars, "22.00"). Echoed back on error. */
  rateDollars: string;
};

export type RateOverrideActionResult =
  | { ok: true }
  | {
      ok: false;
      error: { code: string; message: string };
      values: RateOverrideFormValues;
    };

function snapshot(formData: FormData): RateOverrideFormValues {
  return {
    coachId: formData.get("coachId")?.toString() ?? "",
    resourceType: formData.get("resourceType")?.toString() ?? "",
    rateDollars: formData.get("rateDollars")?.toString() ?? "",
  };
}

/**
 * Parses a user-typed dollar string into cents. Accepts "22", "22.0",
 * "22.50". Rejects negatives, non-numbers, and >2-decimal precision.
 * The 2-decimal-precision rule matches Stripe / Plaid convention and
 * sidesteps float drift in the .005-rounding zone.
 */
function dollarsToCents(input: string): number {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Rate is required");
  // Allow optional leading $ for paste-from-spreadsheet convenience.
  const cleaned = trimmed.replace(/^\$/, "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    throw new Error(
      "Rate must be a positive dollar amount (e.g. 22 or 22.50)",
    );
  }
  const asFloat = Number(cleaned);
  if (!Number.isFinite(asFloat) || asFloat <= 0) {
    throw new Error("Rate must be greater than $0");
  }
  // Multiply BEFORE rounding to dodge float-drift edge cases at
  // exactly half-cent boundaries.
  return Math.round(asFloat * 100);
}

function translate(
  err: unknown,
  values: RateOverrideFormValues,
): RateOverrideActionResult {
  // No typed errors are reachable from the upsert path (overlap /
  // not-found don't apply to upsert). Just Zod + generic Error
  // (the dollar-parser throws plain Error with friendly copy).
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
      error: { code: "INPUT", message: err.message },
      values,
    };
  }
  throw err;
}

export async function upsertRateOverrideFormAction(
  _prev: RateOverrideActionResult,
  formData: FormData,
): Promise<RateOverrideActionResult> {
  const values = snapshot(formData);
  try {
    const cents = dollarsToCents(values.rateDollars);
    await upsertRateOverride({
      coachId: values.coachId,
      resourceType: values.resourceType,
      ratePer30MinCents: cents,
    });
    return { ok: true };
  } catch (err) {
    return translate(err, values);
  }
}
