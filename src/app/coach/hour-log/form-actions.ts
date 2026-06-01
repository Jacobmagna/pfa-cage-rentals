"use server";

// useActionState wrapper for the coach hour-log form. The raw action
// (logOwnHour) throws typed errors; this layer translates them into a
// discriminated-union result so the client can render banners without
// try/catch. Mirrors coach/sessions/new/form-actions.ts.
//
// On success, returns a nonce (timestamp) the client uses to key the
// form's remount → fresh defaults for the next submission.

import { ZodError } from "zod";
import { logOwnHour } from "./actions";
import { ProgramInactiveError, ProgramNotFoundError } from "@/lib/errors";
import { parsePfaInput } from "@/lib/timezone";

export type HourLogFormValues = {
  programId: string;
  date: string;
  startTime: string;
  endTime: string;
  note: string;
};

export type HourLogActionResult =
  | { ok: true; loggedAt: number }
  | {
      ok: false;
      error: { code: string; message: string };
      values: HourLogFormValues;
    };

function snapshot(formData: FormData): HourLogFormValues {
  return {
    programId: formData.get("programId")?.toString() ?? "",
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
  const startAt = parsePfaInput(dateStr, startStr);
  const endAt = parsePfaInput(dateStr, endStr);
  return {
    programId: formData.get("programId")?.toString() ?? "",
    startAt,
    endAt,
    note: formData.get("note")?.toString().trim() || null,
  };
}

function translate(
  err: unknown,
  values: HourLogFormValues,
): HourLogActionResult {
  if (
    err instanceof ProgramNotFoundError ||
    err instanceof ProgramInactiveError
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
  // Unknown — let the Next.js error boundary + Sentry surface it.
  throw err;
}

export async function logOwnHourFormAction(
  _prev: HourLogActionResult,
  formData: FormData,
): Promise<HourLogActionResult> {
  const values = snapshot(formData);
  try {
    await logOwnHour(buildInput(formData));
    return { ok: true, loggedAt: Date.now() };
  } catch (err) {
    return translate(err, values);
  }
}
