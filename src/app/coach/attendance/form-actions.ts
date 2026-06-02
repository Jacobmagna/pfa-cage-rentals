"use server";

// useActionState wrapper for the coach attendance form. The raw action
// (submitOwnAttendance) throws typed errors; this layer translates them
// into a discriminated-union result so the client can render banners
// without try/catch. Mirrors coach/hour-log/form-actions.ts.
//
// FormData shape (from attendance-form.tsx):
//   programId   — hidden input (the selected program)
//   sessionDate — hidden input ("YYYY-MM-DD")
//   athleteId   — one hidden input per roster athlete (the full roster)
//   present     — one checkbox per roster athlete, value=athleteId,
//                 only submitted for the ticked ones
//
// We rebuild records from the FULL roster (athleteId inputs) and mark
// each present iff its id appears in the submitted `present` values.
// The internal action reconciles again against the live roster, so this
// is belt-and-suspenders.

import { ZodError } from "zod";
import { submitOwnAttendance } from "./actions";
import {
  AttendanceEmptyRosterError,
  ProgramInactiveError,
  ProgramNotFoundError,
} from "@/lib/errors";

export type AttendanceActionResult =
  | { ok: true; savedAt: number; present: number; total: number }
  | { ok: false; error: { code: string; message: string } };

function buildInput(formData: FormData) {
  const programId = formData.get("programId")?.toString() ?? "";
  const sessionDate = formData.get("sessionDate")?.toString() ?? "";
  const athleteIds = formData
    .getAll("athleteId")
    .map((v) => v.toString())
    .filter((v) => v.length > 0);
  const presentValues = new Set(
    formData.getAll("present").map((v) => v.toString()),
  );
  const records = athleteIds.map((id) => ({
    athleteId: id,
    present: presentValues.has(id),
  }));
  return { programId, sessionDate, records };
}

function translate(err: unknown): AttendanceActionResult {
  if (
    err instanceof ProgramNotFoundError ||
    err instanceof ProgramInactiveError ||
    err instanceof AttendanceEmptyRosterError
  ) {
    return { ok: false, error: { code: err.code, message: err.message } };
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
    };
  }
  // Unknown — let the Next.js error boundary + Sentry surface it.
  throw err;
}

export async function submitOwnAttendanceFormAction(
  _prev: AttendanceActionResult,
  formData: FormData,
): Promise<AttendanceActionResult> {
  try {
    const result = await submitOwnAttendance(buildInput(formData));
    return {
      ok: true,
      savedAt: Date.now(),
      present: result.present,
      total: result.total,
    };
  } catch (err) {
    return translate(err);
  }
}
