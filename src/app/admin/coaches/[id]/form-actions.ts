"use server";

// useActionState wrapper for the Save form on each rate-override
// row. Translates FormData (rate in dollars as a string) → cents
// integer, and typed errors → discriminated-union result so the
// banner UI doesn't need try/catch.
//
// Remove uses a plain server action; the row's UI is just a button +
// confirm() — no useActionState needed.

import { ZodError } from "zod";
import {
  upsertProgramRateOverrideWithReprice,
  upsertRateOverride,
} from "./actions";
import { RateRepriceDecreaseNotConfirmedError } from "@/lib/errors";
import {
  dollarsToCents,
  hourlyDollarsToCentsPer30Min,
} from "@/lib/rate-input";
import {
  parseConfirmDecrease,
  parseEffectiveFromInput,
} from "@/lib/rate-effective-gate";
import { DECREASE_REFUSED_MESSAGE } from "@/lib/rate-reprice-copy";
import type { RateRepricePreview } from "@/lib/server/rate-reprice";

export type RateOverrideFormValues = {
  coachId: string;
  resourceType: string;
  /** As the user typed it (dollars, "22.00"). Echoed back on error. */
  rateDollars: string;
  /**
   * Weight-room ONLY: the GROUP weight-room rate as the user typed it
   * (dollars/HR). Blank on non-weight-room rows. Echoed back on error.
   */
  groupRateDollars: string;
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
    groupRateDollars: formData.get("groupRateDollars")?.toString() ?? "",
  };
}

// `dollarsToCents` and `hourlyDollarsToCentsPer30Min` used to be defined here.
// Phase D2 moved them to @/lib/rate-input, unchanged, because the CLIENT now
// runs the same conversion to build the candidate rate for the inline preview
// — and two implementations of "dollars → cents" on a payroll surface is
// exactly how a preview ends up quoting a number the save doesn't write.

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
    // Weight-room ONLY: optional GROUP rate. Entered per HOUR / stored per
    // 30 min via the SAME parser as the regular weight-room rate, so the
    // dollars shown equal the dollars charged. The card ALWAYS renders this
    // input for weight_room and promises "leave blank to bill at the regular
    // rate", so a BLANK there is an explicit CLEAR → send `null` (fall back to
    // the regular weight-room rate). A filled value sends the cents. NON-
    // weight-room rows never include the field (undefined) so the internal
    // leaves the column untouched for those callers.
    const groupRatePer30MinCents =
      values.resourceType === "weight_room"
        ? values.groupRateDollars.trim() !== ""
          ? hourlyDollarsToCentsPer30Min(values.groupRateDollars)
          : null
        : undefined;
    await upsertRateOverride({
      coachId: values.coachId,
      resourceType: values.resourceType,
      ratePer30MinCents: cents,
      groupRatePer30MinCents,
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
  /**
   * SPEC rate-effective-dating §7 — "YYYY-MM-DD" the admin picked, or "" for
   * the default "going forward only". Echoed back so a remount after a failed
   * submit restores the choice instead of silently dropping it.
   */
  effectiveFrom: string;
};

export type ProgramRateOverrideActionResult =
  | {
      ok: true;
      /**
       * SPEC §6 — what the retro ACTUALLY did, recomputed and applied
       * server-side. Absent on a "going forward only" save, which stays
       * byte-identical to the behavior before effective dating.
       */
      reprice?: RateRepricePreview | null;
    }
  | {
      ok: false;
      error: { code: string; message: string };
      values: ProgramRateOverrideFormValues;
      /**
       * 🔴 Present ONLY for RateRepriceDecreaseNotConfirmedError: the diff the
       * SERVER computed when it refused. The UI re-renders the named-coach
       * warning from this so the refusal lands on a usable screen rather than
       * an error boundary — and so a race (client preview saw no decrease,
       * server did) is still gated by an explicit second confirmation.
       */
      decreasePreview?: RateRepricePreview;
    };

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
    effectiveFrom: formData.get("effectiveFrom")?.toString() ?? "",
  };
}


function translateProgram(
  err: unknown,
  values: ProgramRateOverrideFormValues,
): ProgramRateOverrideActionResult {
  // 🔴 SPEC §6 — the server refused a retro that would LOWER already-logged
  // pay. NOT an unexpected failure: it is the guard doing its job, and it
  // carries the diff it computed. Surfaced as a normal result (never rethrown)
  // so the row renders the named-coach warning inline instead of white-
  // screening a payroll page into the Next.js error boundary.
  if (err instanceof RateRepriceDecreaseNotConfirmedError) {
    return {
      ok: false,
      error: { code: err.code, message: DECREASE_REFUSED_MESSAGE },
      values,
      decreasePreview: err.preview,
    };
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
    // SPEC §7 — the retro instruction rides on the SAME payload as the rate.
    // Absent/"" is "going forward only": the Phase-C action then does exactly
    // what the old one did (upsert, return) with no preview query, no engine
    // call and no extra write.
    const effectiveFrom = parseEffectiveFromInput(values.effectiveFrom);
    // Only ever true when the admin ticked the required checkbox in the
    // decrease warning — an unticked checkbox is simply not in the payload.
    const confirmDecrease = parseConfirmDecrease(
      formData.get("confirmDecrease"),
    );

    const result = await upsertProgramRateOverrideWithReprice({
      coachId: values.coachId,
      programId: values.programId,
      payMode: values.payMode,
      ratePer30MinCents,
      perSessionRateCents,
      effectiveFrom,
      confirmDecrease,
    });
    return {
      ok: true,
      reprice:
        result.reprice.status === "applied" ? result.reprice.preview : null,
    };
  } catch (err) {
    return translateProgram(err, values);
  }
}
