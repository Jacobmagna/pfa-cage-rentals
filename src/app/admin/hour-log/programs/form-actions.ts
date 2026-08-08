"use server";

// Form-action wrappers for the programs create / edit surfaces. The
// raw actions throw typed errors (ProgramNameTakenError,
// ProgramNotFoundError, ZodError); useActionState wants a stable return
// shape so the client can render error banners without try/catch.
// Mirrors admin/attendance/roster/form-actions.ts + admin/hour-log.
//
// On success the create form returns a nonce (timestamp) the client uses
// to key the form's remount → fresh, empty fields for the next program.

import { ZodError } from "zod";
import {
  createProgram,
  deactivateProgram,
  updateProgram,
  updateProgramWithReprice,
} from "./actions";
import {
  ProgramNameTakenError,
  ProgramNotFoundError,
  RateRepriceDecreaseNotConfirmedError,
} from "@/lib/errors";
import {
  optionalHourlyDollarsToCentsPer30Min,
  optionalSessionDollarsToCents,
} from "@/lib/rate-input";
import {
  parseConfirmDecrease,
  parseEffectiveFromInput,
} from "@/lib/rate-effective-gate";
import { DECREASE_REFUSED_MESSAGE } from "@/lib/rate-reprice-copy";
import type { RateRepricePreview } from "@/lib/server/rate-reprice";

export type ProgramFormValues = {
  name: string;
  rateDollars: string;
  payMode: "hourly" | "per_session";
  perSessionDollars: string;
  /**
   * SPEC rate-effective-dating §7 — "YYYY-MM-DD" the admin picked for the
   * program DEFAULT rate, or "" for "going forward only". EDIT ONLY: a
   * program created one statement ago has no logged hours, so a retro window
   * on it could only ever be a lie (which is why updateProgramSchema carries
   * `defaultRateEffectiveFrom` and createProgramSchema deliberately does not).
   */
  effectiveFrom: string;
};

// The two dollar parsers used to live here. Phase D2 moved them to
// @/lib/rate-input, unchanged, because the CLIENT now runs the same
// conversion to build the candidate rate for the inline preview (SPEC §7) —
// and two implementations of "dollars → cents" on a payroll surface is
// exactly how a preview ends up quoting a number the save doesn't write.
// `optionalHourlyDollarsToCentsPer30Min` HALVES (typed per hour, stored per
// 30 min); `optionalSessionDollarsToCents` does NOT (a flat per-session fee).

export type CreateProgramResult =
  | { ok: true; createdAt: number }
  | {
      ok: false;
      error: { code: string; message: string };
      values: ProgramFormValues;
    };

export type EditProgramResult =
  | {
      ok: true;
      /**
       * SPEC §6 — what the retro ACTUALLY did, recomputed and applied
       * server-side. Absent on a "going forward only" save.
       */
      reprice?: RateRepricePreview | null;
    }
  | {
      ok: false;
      error: { code: string; message: string };
      values: ProgramFormValues;
      /**
       * 🔴 Present ONLY for RateRepriceDecreaseNotConfirmedError — the diff
       * the SERVER computed when it refused. Rendered inline as the
       * named-coach warning, so the refusal is a usable screen and not an
       * error boundary over a payroll page.
       */
      decreasePreview?: RateRepricePreview;
    };

function snapshotProgram(formData: FormData): ProgramFormValues {
  return {
    name: formData.get("name")?.toString() ?? "",
    rateDollars: formData.get("rateDollars")?.toString() ?? "",
    payMode:
      formData.get("payMode")?.toString() === "per_session"
        ? "per_session"
        : "hourly",
    perSessionDollars: formData.get("perSessionDollars")?.toString() ?? "",
    effectiveFrom: formData.get("defaultRateEffectiveFrom")?.toString() ?? "",
  };
}


// Maps FormData → the createProgramSchema / updateProgramSchema shape:
// name + an optional pay rate. The program-level session cap was removed
// (it's now a per-athlete enrollment cap, FEAT-11).
function buildProgramInput(formData: FormData): {
  name: string;
  defaultRatePer30MinCents: number | null;
  payMode: "hourly" | "per_session";
  defaultPerSessionRateCents: number | null;
} {
  const name = formData.get("name")?.toString().trim() ?? "";
  // Optional pay rate (dollars → cents; empty → null). Always present on
  // both create + update so update can clear it back to null.
  const defaultRatePer30MinCents = optionalHourlyDollarsToCentsPer30Min(
    formData.get("rateDollars")?.toString() ?? "",
  );
  const payMode =
    formData.get("payMode")?.toString() === "per_session"
      ? ("per_session" as const)
      : ("hourly" as const);
  const defaultPerSessionRateCents = optionalSessionDollarsToCents(
    formData.get("perSessionDollars")?.toString() ?? "",
  );
  // Both amounts are always sent so switching modes CLEARS the amount that no
  // longer applies — otherwise a program flipped hourly→per-session→hourly
  // would keep a stale flat fee that silently wins in workPayForLog.
  return {
    name,
    defaultRatePer30MinCents:
      payMode === "per_session" ? null : defaultRatePer30MinCents,
    payMode,
    defaultPerSessionRateCents:
      payMode === "per_session" ? defaultPerSessionRateCents : null,
  };
}

function zodMessage(err: ZodError): string {
  const first = err.issues[0];
  return first ? `${first.path.join(".")}: ${first.message}` : "Invalid input";
}

export async function createProgramFormAction(
  _prev: CreateProgramResult,
  formData: FormData,
): Promise<CreateProgramResult> {
  const values = snapshotProgram(formData);
  let input;
  try {
    // buildProgramInput can throw a friendly Error from the dollar parser
    // (bad pay-rate string). Catch it here so it surfaces in the banner
    // instead of bubbling to the error boundary.
    input = buildProgramInput(formData);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "INPUT",
        message: err instanceof Error ? err.message : "Invalid input",
      },
      values,
    };
  }
  try {
    await createProgram(input);
    return { ok: true, createdAt: Date.now() };
  } catch (err) {
    if (err instanceof ProgramNameTakenError) {
      return {
        ok: false,
        error: { code: err.code, message: err.message },
        values,
      };
    }
    if (err instanceof ZodError) {
      return {
        ok: false,
        error: { code: "VALIDATION", message: zodMessage(err) },
        values,
      };
    }
    // Unknown — let Next.js error boundary + Sentry handle it.
    throw err;
  }
}

export async function updateProgramFormAction(
  _prev: EditProgramResult,
  formData: FormData,
): Promise<EditProgramResult> {
  const values = snapshotProgram(formData);
  const id = formData.get("id")?.toString();
  if (!id) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "Missing program id" },
      values,
    };
  }
  let input;
  let effectiveFrom: Date | null;
  try {
    input = buildProgramInput(formData);
    effectiveFrom = parseEffectiveFromInput(values.effectiveFrom);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "INPUT",
        message: err instanceof Error ? err.message : "Invalid input",
      },
      values,
    };
  }
  try {
    // SPEC §7 — the retro instruction rides on the SAME payload as the rate.
    // With `defaultRateEffectiveFrom` null this is `updateProgram` exactly:
    // same internal, no preview query, no engine call, no extra write.
    // Only ever true when the admin ticked the required checkbox in the
    // decrease warning — an unticked checkbox is not in the payload at all.
    const confirmDecrease = parseConfirmDecrease(
      formData.get("confirmDecrease"),
    );
    const result = await updateProgramWithReprice(id, {
      ...input,
      defaultRateEffectiveFrom: effectiveFrom,
      confirmDecrease,
    });
    return {
      ok: true,
      reprice:
        result.reprice.status === "applied" ? result.reprice.preview : null,
    };
  } catch (err) {
    // 🔴 SPEC §6 — the server refused a retro that would LOWER already-logged
    // pay. Surfaced as a normal result (never rethrown) so the dialog renders
    // the named-coach warning inline instead of white-screening into the
    // Next.js error boundary.
    if (err instanceof RateRepriceDecreaseNotConfirmedError) {
      return {
        ok: false,
        error: { code: err.code, message: DECREASE_REFUSED_MESSAGE },
        values,
        decreasePreview: err.preview,
      };
    }
    if (
      err instanceof ProgramNameTakenError ||
      err instanceof ProgramNotFoundError
    ) {
      return {
        ok: false,
        error: { code: err.code, message: err.message },
        values,
      };
    }
    if (err instanceof ZodError) {
      return {
        ok: false,
        error: { code: "VALIDATION", message: zodMessage(err) },
        values,
      };
    }
    throw err;
  }
}

// Deactivate / reactivate don't use useActionState — ConfirmDialog +
// a button (deactivate) or a direct button (reactivate). Returns a
// Result so the client can surface ProgramNotFoundError inline instead
// of bubbling to the error boundary. Revalidation happens inside the
// public actions.
export type ProgramActionResult =
  | { ok: true }
  | { ok: false; error: { code: string; message: string } };

export async function deactivateProgramAction(
  id: string,
): Promise<ProgramActionResult> {
  try {
    await deactivateProgram(id);
    return { ok: true };
  } catch (err) {
    if (err instanceof ProgramNotFoundError) {
      return { ok: false, error: { code: err.code, message: err.message } };
    }
    throw err;
  }
}

export async function reactivateProgramAction(
  id: string,
): Promise<ProgramActionResult> {
  try {
    await updateProgram(id, { active: true });
    return { ok: true };
  } catch (err) {
    if (err instanceof ProgramNotFoundError) {
      return { ok: false, error: { code: err.code, message: err.message } };
    }
    throw err;
  }
}
