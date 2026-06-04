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
import {
  addAthlete,
  archiveAthletes,
  assignAthletes,
  deleteAthlete,
  updateAthlete,
} from "./actions";
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
  // Term picker submits these two fields separately; the form composes
  // them into the normalized "Season YYYY" string (DEC-28).
  season: string;
  year: string;
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
    season: formData.get("season")?.toString() ?? "",
    year: formData.get("year")?.toString() ?? "",
  };
}

// Maps FormData → the createAthleteSchema / updateAthleteSchema shape.
// An empty birthday becomes null (the column is nullable). The term
// picker submits `season` + `year`; with both set we compose the
// normalized "Season YYYY" string, otherwise null. The "exactly one
// set" error case is caught in the form-actions BEFORE this runs, so
// here we can assume valid (both-or-neither) input (DEC-28).
function buildAthleteInput(formData: FormData) {
  const season = formData.get("season")?.toString().trim() ?? "";
  const year = formData.get("year")?.toString().trim() ?? "";
  return {
    firstName: formData.get("firstName")?.toString().trim() ?? "",
    lastName: formData.get("lastName")?.toString().trim() ?? "",
    birthday: formData.get("birthday")?.toString().trim() || null,
    term: season && year ? `${season} ${year}` : null,
  };
}

// True when exactly one of season/year is set — an invalid "half a
// term" submission we reject at the form layer (DEC-28).
function termIncomplete(formData: FormData): boolean {
  const season = formData.get("season")?.toString().trim() ?? "";
  const year = formData.get("year")?.toString().trim() ?? "";
  return Boolean(season) !== Boolean(year);
}

const TERM_INCOMPLETE_MESSAGE =
  "Choose both a season and a year, or leave both blank.";

function zodMessage(err: ZodError): string {
  const first = err.issues[0];
  return first ? `${first.path.join(".")}: ${first.message}` : "Invalid input";
}

export async function addAthleteFormAction(
  _prev: AddAthleteResult,
  formData: FormData,
): Promise<AddAthleteResult> {
  const values = snapshotAthlete(formData);
  if (termIncomplete(formData)) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: TERM_INCOMPLETE_MESSAGE },
      values,
    };
  }
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
  if (termIncomplete(formData)) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: TERM_INCOMPLETE_MESSAGE },
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
  // Cap is only present when the "Specific session cap" box is checked.
  // Empty / missing → undefined so the schema's "no cap" (clear) path
  // applies and the co-requirement refine doesn't trip.
  const capRaw = formData.get("cap")?.toString().trim() ?? "";
  const capPeriodRaw = formData.get("capPeriod")?.toString().trim() ?? "";
  const cap = capRaw === "" ? undefined : capRaw;
  const capPeriod = capPeriodRaw === "" ? undefined : capPeriodRaw;
  try {
    await assignAthletes({ athleteIds, programId, mode, cap, capPeriod });
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

// Bulk-archive helper for the roster client (ConfirmDialog flow, like
// delete). archiveAthletes throws no typed errors, so there's nothing
// to catch here — any unknown error bubbles to the error boundary.
export type ArchiveAthletesResult =
  | { ok: true; archivedAt: number }
  | { ok: false; error: { code: string; message: string } };

export async function archiveAthletesAction(
  ids: string[],
): Promise<ArchiveAthletesResult> {
  await archiveAthletes(ids);
  return { ok: true, archivedAt: Date.now() };
}
