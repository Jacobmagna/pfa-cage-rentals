"use server";

// Form-action wrappers for the programs create / edit / coaches
// surfaces. The raw actions throw typed errors (ProgramNameTakenError,
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
  setProgramCoaches,
  updateProgram,
} from "./actions";
import { ProgramNameTakenError, ProgramNotFoundError } from "@/lib/errors";

export type ProgramFormValues = {
  name: string;
  cap: string;
  capPeriod: string;
  limit: boolean;
};

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

export type SetCoachesResult =
  | { ok: true; savedAt: number }
  | { ok: false; error: { code: string; message: string } };

function snapshotProgram(formData: FormData): ProgramFormValues {
  return {
    name: formData.get("name")?.toString() ?? "",
    cap: formData.get("cap")?.toString() ?? "",
    capPeriod: formData.get("capPeriod")?.toString() ?? "",
    limit: formData.get("limit") === "on",
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
} {
  const name = formData.get("name")?.toString().trim() ?? "";
  const limit = formData.get("limit") === "on";
  if (!limit) {
    return { name, cap: null, capPeriod: null };
  }
  const capRaw = formData.get("cap")?.toString().trim() ?? "";
  const capNum = capRaw === "" ? NaN : Number(capRaw);
  const periodRaw = formData.get("capPeriod")?.toString().trim() ?? "";
  return {
    name,
    cap: Number.isNaN(capNum) ? (NaN as unknown as number) : capNum,
    capPeriod: (periodRaw || null) as "week" | "month" | null,
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
  try {
    await createProgram(buildProgramInput(formData));
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
  try {
    await updateProgram(id, buildProgramInput(formData));
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

export async function setProgramCoachesFormAction(
  _prev: SetCoachesResult,
  formData: FormData,
): Promise<SetCoachesResult> {
  const programId = formData.get("programId")?.toString() ?? "";
  const coachIds = formData.getAll("coachId").map((v) => v.toString());
  try {
    await setProgramCoaches(programId, coachIds);
    return { ok: true, savedAt: Date.now() };
  } catch (err) {
    if (err instanceof ProgramNotFoundError) {
      return { ok: false, error: { code: err.code, message: err.message } };
    }
    if (err instanceof ZodError) {
      return {
        ok: false,
        error: { code: "VALIDATION", message: zodMessage(err) },
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
