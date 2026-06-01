"use server";

// Form-action wrapper for the admin hour-log edit dialog. The raw
// action (updateHour) throws typed errors (HourLogNotFoundError,
// ZodError, etc.); useActionState wants a stable return shape so the
// dialog can render error banners without try/catch in the client.
//
// Mirrors admin/sessions/form-actions.ts: snapshot the submitted
// values so the form re-renders pre-filled on error, build the schema
// input from FormData, translate typed errors into a discriminated
// union, rethrow unknown errors (Next.js error boundary + Sentry).
//
// The edit dialog only changes times + note; programId rides along as
// a hidden field so editHourLogSchema (which requires it) parses. We
// still map ProgramInactiveError / ProgramNotFoundError defensively in
// case a stale program id surfaces.

import { ZodError } from "zod";
import { deleteHour, updateHour } from "./actions";
import {
  HourLogNotFoundError,
  ProgramInactiveError,
  ProgramNotFoundError,
} from "@/lib/errors";
import { parsePfaInput } from "@/lib/timezone";

export type SubmittedHourValues = {
  programId: string;
  date: string;
  startTime: string;
  endTime: string;
  note: string;
};

export type HourActionResult =
  | { ok: true }
  | {
      ok: false;
      error: { code: string; message: string };
      values: SubmittedHourValues;
    };

// Snapshot the form's raw values so we can re-render pre-filled when
// the action errors — without this the admin re-types the time/note
// after every validation failure.
function snapshotFormValues(formData: FormData): SubmittedHourValues {
  return {
    programId: formData.get("programId")?.toString() ?? "",
    date: formData.get("date")?.toString() ?? "",
    startTime: formData.get("startTime")?.toString() ?? "",
    endTime: formData.get("endTime")?.toString() ?? "",
    note: formData.get("note")?.toString() ?? "",
  };
}

// Maps FormData → the shape editHourLogSchema expects. Combines the
// date input and two time inputs into UTC Date instants.
function buildHourInput(formData: FormData) {
  const dateStr = formData.get("date")?.toString().trim();
  const startStr = formData.get("startTime")?.toString().trim();
  const endStr = formData.get("endTime")?.toString().trim();
  if (!dateStr || !startStr || !endStr) {
    throw new Error("Missing date, start, or end time");
  }
  const startAt = parsePfaInput(dateStr, startStr);
  const endAt = parsePfaInput(dateStr, endStr);
  return {
    programId: formData.get("programId")?.toString() ?? "",
    startAt,
    endAt,
    note: formData.get("note")?.toString().trim() || null,
  };
}

function translateError(
  err: unknown,
  values: SubmittedHourValues,
): HourActionResult {
  if (
    err instanceof HourLogNotFoundError ||
    err instanceof ProgramInactiveError ||
    err instanceof ProgramNotFoundError
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
  // Unknown — let Next.js error boundary + Sentry handle it.
  throw err;
}

export async function updateHourFormAction(
  _prev: HourActionResult,
  formData: FormData,
): Promise<HourActionResult> {
  const values = snapshotFormValues(formData);
  const id = formData.get("id")?.toString();
  if (!id) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "Missing hour-log id" },
      values,
    };
  }
  try {
    await updateHour(id, buildHourInput(formData));
    return { ok: true };
  } catch (err) {
    return translateError(err, values);
  }
}

// Delete doesn't use useActionState — ConfirmDialog + a simple button.
// Revalidation happens inside the public deleteHour action.
export async function deleteHourAction(id: string): Promise<void> {
  await deleteHour(id);
}
