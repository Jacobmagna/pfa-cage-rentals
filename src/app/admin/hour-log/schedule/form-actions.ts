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
  cancelSeriesOccurrence,
  createProgramScheduleBlock,
  createProgramScheduleSeries,
  deleteProgramScheduleBlock,
  editProgramScheduleSeries,
  updateProgramScheduleBlock,
} from "./actions";
import {
  BlockConflictsWithSessionError,
  BlockOverlapError,
  CoachNotFoundError,
  NotASeriesOccurrenceError,
  ProgramInactiveError,
  ProgramNotFoundError,
  ProgramScheduleBlockNotFoundError,
  ProgramScheduleSeriesNotFoundError,
} from "@/lib/errors";
import { parsePfaInput } from "@/lib/timezone";

export type ProgramScheduleFormValues = {
  programId: string;
  // QA10 W3.2: the full submitted scheduled-coach set (primary = [0]).
  scheduledCoachIds: string[];
  // QA10 W3.3: the cage resources the block/series occupies.
  resourceIds: string[];
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
    scheduledCoachIds: formData
      .getAll("scheduledCoachIds")
      .map((v) => v.toString())
      .filter(Boolean),
    resourceIds: formData.getAll("resourceIds").map(String).filter(Boolean),
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
    scheduledCoachIds: formData
      .getAll("scheduledCoachIds")
      .map((v) => v.toString())
      .filter(Boolean),
    resourceIds: formData.getAll("resourceIds").map(String).filter(Boolean),
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
    err instanceof ProgramScheduleBlockNotFoundError ||
    err instanceof ProgramScheduleSeriesNotFoundError ||
    err instanceof NotASeriesOccurrenceError ||
    // QA10 W3.3: occupying a busy cage resource → inline red banner.
    err instanceof BlockConflictsWithSessionError ||
    err instanceof BlockOverlapError
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

// Build the recurring-series input from a form. Shared by the create path
// (RECUR-b1) and the edit-series path (RECUR-b2): `daysOfWeek` collects
// every checked weekday pill (0=Sun..6=Sat) via getAll, parsed to numbers;
// start/end stay the raw "HH:MM" the series schema expects (NOT composed
// to instants); the season-end DateInput's hidden ISO becomes `endsOn`.
//
// startsOn: the edit-series form submits an explicit `startsOn` ISO (the
// season-start DateInput), so we prefer it when present. The create form
// has no `startsOn` field and falls back to the grid's selected `date`
// hidden field — keeping the create contract unchanged.
function buildSeriesInput(formData: FormData) {
  const note = formData.get("note")?.toString().trim() ?? "";
  const explicitStartsOn = formData.get("startsOn")?.toString().trim();
  const startsOn =
    explicitStartsOn && explicitStartsOn.length > 0
      ? explicitStartsOn
      : (formData.get("date")?.toString().trim() ?? "");
  // QA10 W3.1b: recurrence pattern. The dialog submits hidden `frequency`
  // ("weekly"|"monthly") + `interval` (≥1) fields. Forward them only when
  // present so a payload omitting them falls back to the zod defaults
  // (weekly/1) — preserving today's every-week behavior for old callers.
  const frequencyRaw = formData.get("frequency")?.toString().trim();
  const intervalRaw = formData.get("interval")?.toString().trim();
  return {
    programId: formData.get("programId")?.toString() ?? "",
    scheduledCoachIds: formData
      .getAll("scheduledCoachIds")
      .map((v) => v.toString())
      .filter(Boolean),
    resourceIds: formData.getAll("resourceIds").map(String).filter(Boolean),
    daysOfWeek: formData
      .getAll("daysOfWeek")
      .map((v) => Number(v.toString())),
    startTime: formData.get("startTime")?.toString().trim() ?? "",
    endTime: formData.get("endTime")?.toString().trim() ?? "",
    startsOn,
    endsOn: formData.get("endsOn")?.toString().trim() ?? "",
    ...(frequencyRaw ? { frequency: frequencyRaw } : {}),
    ...(intervalRaw ? { interval: intervalRaw } : {}),
    note: note.length > 0 ? note : null,
  };
}

export async function createProgramScheduleBlockFormAction(
  _prev: ProgramScheduleActionResult,
  formData: FormData,
): Promise<ProgramScheduleActionResult> {
  const values = snapshot(formData);
  const recurring = formData.get("recurring")?.toString() === "on";
  try {
    if (recurring) {
      await createProgramScheduleSeries(buildSeriesInput(formData));
    } else {
      await createProgramScheduleBlock(buildInput(formData));
    }
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

// RECUR-b2: edit the WHOLE series (locked model — no single-occurrence
// edit). Reads the hidden seriesId, rebuilds the full editable series
// definition from the form via buildSeriesInput (which prefers the
// explicit `startsOn` field the edit form submits), then calls the gated
// editProgramScheduleSeries action. Typed errors → inline banner.
export async function editProgramScheduleSeriesFormAction(
  _prev: ProgramScheduleActionResult,
  formData: FormData,
): Promise<ProgramScheduleActionResult> {
  const values = snapshot(formData);
  const seriesId = formData.get("seriesId")?.toString();
  if (!seriesId) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "Missing series id" },
      values,
    };
  }
  try {
    await editProgramScheduleSeries(seriesId, buildSeriesInput(formData));
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

// RECUR-b2: cancel a SINGLE occurrence of a series (locked model). Mirrors
// deleteProgramScheduleBlockAction — ConfirmDialog + a button, returns a
// Result so the client surfaces a typed error inline. Revalidation happens
// inside the public cancelSeriesOccurrence action.
export async function cancelSeriesOccurrenceAction(
  blockId: string,
): Promise<DeleteProgramScheduleBlockResult> {
  try {
    await cancelSeriesOccurrence(blockId);
    return { ok: true };
  } catch (err) {
    if (
      err instanceof NotASeriesOccurrenceError ||
      err instanceof ProgramScheduleSeriesNotFoundError ||
      err instanceof ProgramScheduleBlockNotFoundError
    ) {
      return { ok: false, error: { code: err.code, message: err.message } };
    }
    throw err;
  }
}
