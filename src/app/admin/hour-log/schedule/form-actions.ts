"use server";

// useActionState wrappers for the program-block create/edit dialog +
// a Result-returning delete action. Same translation pattern as
// admin/schedule/form-actions.ts — typed errors → red banner copy,
// anything else re-thrown to the Next error boundary.
//
// Revalidation invariant: ./actions.ts owns revalidatePath for the
// programs schedule surface. These wrappers focus on FormData
// translation + typed-error → banner-copy mapping only.

import { ZodError } from "zod";
import {
  createProgramScheduleBlock,
  deleteProgramScheduleBlock,
  updateProgramScheduleBlock,
} from "./actions";
import {
  CoachNotFoundError,
  ProgramInactiveError,
  ProgramNotFoundError,
  ProgramScheduleBlockNotFoundError,
} from "@/lib/errors";
import { parsePfaInput } from "@/lib/timezone";

export type ProgramScheduleFormValues = {
  programId: string;
  scheduledCoachId: string;
  date: string;
  startTime: string;
  endTime: string;
  note: string;
};

export type ProgramScheduleActionResult =
  | { ok: true }
  | {
      ok: false;
      error: { code: string; message: string };
      values: ProgramScheduleFormValues;
    };

function snapshot(formData: FormData): ProgramScheduleFormValues {
  return {
    programId: formData.get("programId")?.toString() ?? "",
    scheduledCoachId: formData.get("scheduledCoachId")?.toString() ?? "",
    date: formData.get("date")?.toString() ?? "",
    startTime: formData.get("startTime")?.toString() ?? "",
    endTime: formData.get("endTime")?.toString() ?? "",
    note: formData.get("note")?.toString() ?? "",
  };
}

function buildInput(formData: FormData) {
  const dateStr = formData.get("date")?.toString().trim();
  const startStr = formData.get("startTime")?.toString().trim();
  const endStr = formData.get("endTime")?.toString().trim();
  if (!dateStr || !startStr || !endStr) {
    throw new Error("Missing date, start, or end time");
  }
  const note = formData.get("note")?.toString().trim() ?? "";
  return {
    programId: formData.get("programId")?.toString() ?? "",
    scheduledCoachId: formData.get("scheduledCoachId")?.toString() ?? "",
    startAt: parsePfaInput(dateStr, startStr),
    endAt: parsePfaInput(dateStr, endStr),
    note: note.length > 0 ? note : null,
  };
}

function translate(
  err: unknown,
  values: ProgramScheduleFormValues,
): ProgramScheduleActionResult {
  if (
    err instanceof ProgramNotFoundError ||
    err instanceof ProgramInactiveError ||
    err instanceof CoachNotFoundError ||
    err instanceof ProgramScheduleBlockNotFoundError
  ) {
    return {
      ok: false,
      error: { code: err.code, message: err.message },
      values,
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
  throw err;
}

export async function createProgramScheduleBlockFormAction(
  _prev: ProgramScheduleActionResult,
  formData: FormData,
): Promise<ProgramScheduleActionResult> {
  const values = snapshot(formData);
  try {
    await createProgramScheduleBlock(buildInput(formData));
    return { ok: true };
  } catch (err) {
    return translate(err, values);
  }
}

export async function updateProgramScheduleBlockFormAction(
  _prev: ProgramScheduleActionResult,
  formData: FormData,
): Promise<ProgramScheduleActionResult> {
  const values = snapshot(formData);
  const id = formData.get("id")?.toString();
  if (!id) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "Missing block id" },
      values,
    };
  }
  try {
    await updateProgramScheduleBlock(id, buildInput(formData));
    return { ok: true };
  } catch (err) {
    return translate(err, values);
  }
}

// Delete doesn't use useActionState — ConfirmDialog + a button. Returns
// a Result so the client can surface a typed error inline instead of
// bubbling to the error boundary. Revalidation happens inside the
// public deleteProgramScheduleBlock action.
export type DeleteProgramScheduleBlockResult =
  | { ok: true }
  | { ok: false; error: { code: string; message: string } };

export async function deleteProgramScheduleBlockAction(
  id: string,
): Promise<DeleteProgramScheduleBlockResult> {
  try {
    await deleteProgramScheduleBlock(id);
    return { ok: true };
  } catch (err) {
    if (err instanceof ProgramScheduleBlockNotFoundError) {
      return { ok: false, error: { code: err.code, message: err.message } };
    }
    throw err;
  }
}
