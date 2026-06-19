"use server";

// useActionState wrapper for the Save form on each rate-override
// row. Translates FormData (rate in dollars as a string) → cents
// integer, and typed errors → discriminated-union result so the
// banner UI doesn't need try/catch.
//
// Remove uses a plain server action; the row's UI is just a button +
// confirm() — no useActionState needed.

import { ZodError } from "zod";
import { upsertProgramRateOverride, upsertRateOverride } from "./actions";

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
    // Weight room is ENTERED per HOUR but STORED per 30 min (reuses the
    // program-override hourly parser). Cages & bullpens stay per 30 min.
    const cents =
      values.resourceType === "weight_room"
        ? hourlyDollarsToCentsPer30Min(values.rateDollars)
        : dollarsToCents(values.rateDollars);
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

// --- Per-coach PROGRAM rate overrides ---------------------------------
// Mirrors the resource-type override form-action above but keyed on
// (coachId, programId). Reuses the same dollarsToCents parser (override
// must be ≥ $0.01) and the same discriminated-union result shape.

export type ProgramRateOverrideFormValues = {
  coachId: string;
  programId: string;
  /** How this program pays the coach: hourly rate vs flat per-session. */
  payMode: "hourly" | "per_session";
  /** Hourly rate as the user typed it (dollars/HR). Echoed back on error. */
  rateDollars: string;
  /** Flat per-session amount as typed (dollars). Echoed back on error. */
  perSessionDollars: string;
};

export type ProgramRateOverrideActionResult =
  | { ok: true }
  | {
      ok: false;
      error: { code: string; message: string };
      values: ProgramRateOverrideFormValues;
    };

/**
 * PROGRAM (work) override rates are ENTERED per HOUR but STORED per
 * 30 min. Same validation as the cage dollarsToCents parser, but the
 * entered dollars are halved to the per-30-min storage unit:
 * cents = round(dollarsPerHour * 100 / 2). Cage rates keep using
 * dollarsToCents (per 30 min) — only programs switched to hourly entry.
 */
function hourlyDollarsToCentsPer30Min(input: string): number {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Rate is required");
  const cleaned = trimmed.replace(/^\$/, "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    throw new Error(
      "Rate must be a positive dollar amount (e.g. 44 or 44.50)",
    );
  }
  const asFloat = Number(cleaned);
  if (!Number.isFinite(asFloat) || asFloat <= 0) {
    throw new Error("Rate must be greater than $0");
  }
  // Entered per HOUR → stored per 30 min (half).
  return Math.round((asFloat * 100) / 2);
}

function snapshotProgram(
  formData: FormData,
): ProgramRateOverrideFormValues {
  const rawMode = formData.get("payMode")?.toString();
  const payMode: "hourly" | "per_session" =
    rawMode === "per_session" ? "per_session" : "hourly";
  return {
    coachId: formData.get("coachId")?.toString() ?? "",
    programId: formData.get("programId")?.toString() ?? "",
    payMode,
    rateDollars: formData.get("rateDollars")?.toString() ?? "",
    perSessionDollars: formData.get("perSessionDollars")?.toString() ?? "",
  };
}

function translateProgram(
  err: unknown,
  values: ProgramRateOverrideFormValues,
): ProgramRateOverrideActionResult {
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

export async function upsertProgramRateOverrideFormAction(
  _prev: ProgramRateOverrideActionResult,
  formData: FormData,
): Promise<ProgramRateOverrideActionResult> {
  const values = snapshotProgram(formData);
  try {
    // Branch on pay mode. Hourly: entered per HOUR → stored per 30 min,
    // per-session cents null. Per session: a FLAT dollar amount (no ×2),
    // hourly cents null. The inactive amount field is ignored.
    let ratePer30MinCents: number | null = null;
    let perSessionRateCents: number | null = null;
    if (values.payMode === "per_session") {
      perSessionRateCents = dollarsToCents(values.perSessionDollars);
    } else {
      ratePer30MinCents = hourlyDollarsToCentsPer30Min(values.rateDollars);
    }
    await upsertProgramRateOverride({
      coachId: values.coachId,
      programId: values.programId,
      payMode: values.payMode,
      ratePer30MinCents,
      perSessionRateCents,
    });
    return { ok: true };
  } catch (err) {
    return translateProgram(err, values);
  }
}
