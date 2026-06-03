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
import { createProgram, deactivateProgram, updateProgram } from "./actions";
import { ProgramNameTakenError, ProgramNotFoundError } from "@/lib/errors";

export type ProgramFormValues = {
  name: string;
  cap: string;
  capPeriod: string;
  limit: boolean;
  rateDollars: string;
};

/**
 * Parses an OPTIONAL user-typed dollar string into integer cents.
 * Empty/blank → null (no rate set). Otherwise mirrors the resource-type
 * override parser in admin/coaches/[id]/form-actions.ts: accepts "22",
 * "22.0", "22.50", optional leading $, max 2-decimal precision; multiply
 * before rounding to dodge half-cent float drift. Rejects negatives and
 * non-numbers so Zod's int/min/max cap fires a clean error.
 */
function optionalDollarsToCents(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const cleaned = trimmed.replace(/^\$/, "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    throw new Error(
      "Pay rate must be a positive dollar amount (e.g. 22 or 22.50)",
    );
  }
  const asFloat = Number(cleaned);
  if (!Number.isFinite(asFloat) || asFloat < 0) {
    throw new Error("Pay rate must be a positive dollar amount");
  }
  return Math.round(asFloat * 100);
}

export type CreateProgramResult =
  | { ok: true; createdAt: number }
  | {
      ok: false;
      error: { code: string; message: string };
      values: ProgramFormValues;
    };

export type EditProgramResult =
  | { ok: true }
  | {
      ok: false;
      error: { code: string; message: string };
      values: ProgramFormValues;
    };

function snapshotProgram(formData: FormData): ProgramFormValues {
  return {
    name: formData.get("name")?.toString() ?? "",
    cap: formData.get("cap")?.toString() ?? "",
    capPeriod: formData.get("capPeriod")?.toString() ?? "",
    limit: formData.get("limit") === "on",
    rateDollars: formData.get("rateDollars")?.toString() ?? "",
  };
}

// Maps FormData → the createProgramSchema / updateProgramSchema shape.
// When the "Limit sessions" checkbox is off we clear cap + capPeriod
// (null for update, which also satisfies create's omit semantics — the
// Zod refine treats null/undefined identically). When on, we parse the
// number (NaN → undefined so Zod's positive-int check fires a friendly
// error rather than a coercion surprise).
function buildProgramInput(formData: FormData): {
  name: string;
  cap: number | null;
  capPeriod: "week" | "month" | null;
  defaultRatePer30MinCents: number | null;
} {
  const name = formData.get("name")?.toString().trim() ?? "";
  // Optional pay rate (dollars → cents; empty → null). Always present on
  // both create + update so update can clear it back to null.
  const defaultRatePer30MinCents = optionalDollarsToCents(
    formData.get("rateDollars")?.toString() ?? "",
  );
  const limit = formData.get("limit") === "on";
  if (!limit) {
    return { name, cap: null, capPeriod: null, defaultRatePer30MinCents };
  }
  const capRaw = formData.get("cap")?.toString().trim() ?? "";
  const capNum = capRaw === "" ? NaN : Number(capRaw);
  const periodRaw = formData.get("capPeriod")?.toString().trim() ?? "";
  return {
    name,
    cap: Number.isNaN(capNum) ? (NaN as unknown as number) : capNum,
    capPeriod: (periodRaw || null) as "week" | "month" | null,
    defaultRatePer30MinCents,
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
  try {
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
    await updateProgram(id, input);
    return { ok: true };
  } catch (err) {
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
