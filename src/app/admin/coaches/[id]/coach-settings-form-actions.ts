"use server";

// useActionState wrapper for the QA2 coach-detail Notes card:
//   #8 Notes card → updateCoachNotesFormAction
//
// (The coach-wide work-pay-mode card was retired by DESIGN-1: pay mode is
// now a per-program setting on the Work rates card, so its form-action was
// removed from this file.)
//
// Same pattern as the handles / rate-override form-actions: snapshot the
// typed values so a Zod failure remounts the form with what the admin had
// in flight, instead of blanking the inputs.

import { ZodError } from "zod";
import { updateCoachNotes } from "./actions";
import { CoachNotFoundError } from "@/lib/errors";

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
