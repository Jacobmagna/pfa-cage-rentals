"use server";

// Form-action wrappers for the roster add / edit / assign surfaces. The
// raw actions throw typed errors (AthleteNotFoundError,
// AthleteHasRecordsError, ProgramNotFoundError, ProgramInactiveError,
// ZodError); useActionState wants a stable return shape so the client
// can render error banners without try/catch. Mirrors
// admin/hour-log/form-actions.ts.
//
// On success the add form returns a nonce (timestamp) the client uses
// to key the form's remount → fresh, empty fields for the next athlete.

import { ZodError } from "zod";
import { addAthlete, assignAthletes, deleteAthlete, updateAthlete } from "./actions";
import {
  AthleteHasRecordsError,
  AthleteNotFoundError,
  ProgramInactiveError,
  ProgramNotFoundError,
} from "@/lib/errors";

export type AthleteFormValues = {
  firstName: string;
  lastName: string;
  birthday: string;
};

export type AddAthleteResult =
  | { ok: true; addedAt: number }
  | {
      ok: false;
      error: { code: string; message: string };
      values: AthleteFormValues;
    };

export type EditAthleteResult =
  | { ok: true }
  | {
      ok: false;
      error: { code: string; message: string };
      values: AthleteFormValues;
    };

export type AssignAthletesResult =
  | { ok: true; assignedAt: number }
  | { ok: false; error: { code: string; message: string } };

function snapshotAthlete(formData: FormData): AthleteFormValues {
  return {
    firstName: formData.get("firstName")?.toString() ?? "",
    lastName: formData.get("lastName")?.toString() ?? "",
    birthday: formData.get("birthday")?.toString() ?? "",
  };
}

// Maps FormData → the createAthleteSchema / updateAthleteSchema shape.
// An empty birthday becomes null (the column is nullable).
function buildAthleteInput(formData: FormData) {
  return {
    firstName: formData.get("firstName")?.toString().trim() ?? "",
    lastName: formData.get("lastName")?.toString().trim() ?? "",
    birthday: formData.get("birthday")?.toString().trim() || null,
  };
}

function zodMessage(err: ZodError): string {
  const first = err.issues[0];
  return first ? `${first.path.join(".")}: ${first.message}` : "Invalid input";
}

export async function addAthleteFormAction(
  _prev: AddAthleteResult,
  formData: FormData,
): Promise<AddAthleteResult> {
  const values = snapshotAthlete(formData);
  try {
    await addAthlete(buildAthleteInput(formData));
    return { ok: true, addedAt: Date.now() };
  } catch (err) {
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

export async function updateAthleteFormAction(
  _prev: EditAthleteResult,
  formData: FormData,
): Promise<EditAthleteResult> {
  const values = snapshotAthlete(formData);
  const id = formData.get("id")?.toString();
  if (!id) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "Missing athlete id" },
      values,
    };
  }
  try {
    await updateAthlete(id, buildAthleteInput(formData));
    return { ok: true };
  } catch (err) {
    if (err instanceof AthleteNotFoundError) {
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

export async function assignAthletesFormAction(
  _prev: AssignAthletesResult,
  formData: FormData,
): Promise<AssignAthletesResult> {
  const athleteIds = formData.getAll("athleteId").map((v) => v.toString());
  const programId = formData.get("programId")?.toString() ?? "";
  const mode = formData.get("mode")?.toString() === "move" ? "move" : "add";
  try {
    await assignAthletes({ athleteIds, programId, mode });
    return { ok: true, assignedAt: Date.now() };
  } catch (err) {
    if (
      err instanceof ProgramNotFoundError ||
      err instanceof ProgramInactiveError
    ) {
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

// Delete doesn't use useActionState — ConfirmDialog + a button. Returns
// a Result so the client can surface AthleteHasRecordsError inline
// instead of bubbling to the error boundary. Revalidation happens
// inside the public deleteAthlete action.
export type DeleteAthleteResult =
  | { ok: true }
  | { ok: false; error: { code: string; message: string } };

export async function deleteAthleteAction(
  id: string,
): Promise<DeleteAthleteResult> {
  try {
    await deleteAthlete(id);
    return { ok: true };
  } catch (err) {
    if (
      err instanceof AthleteHasRecordsError ||
      err instanceof AthleteNotFoundError
    ) {
      return { ok: false, error: { code: err.code, message: err.message } };
    }
    throw err;
  }
}
