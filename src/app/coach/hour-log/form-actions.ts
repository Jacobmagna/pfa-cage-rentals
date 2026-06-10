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
import {
  HeldLogReviewRequiredError,
  ProgramInactiveError,
  ProgramNotFoundError,
} from "@/lib/errors";
import { parsePfaInput } from "@/lib/timezone";

export type HourLogFormValues = {
  programId: string;
  date: string;
  startTime: string;
  endTime: string;
  note: string;
};

export type HourLogActionResult =
  // Clean post. `held` distinguishes a successfully HELD log (sent for
  // approval) from a normal posted one, so the form can show the right
  // confirmation copy.
  | { ok: true; loggedAt: number; held?: boolean }
  // The manual log was anomalous and not yet acknowledged — the form shows
  // a warning with "send for approval" / "go back and edit". Discriminated
  // from the plain-error variant by the `requiresHold` field.
  | {
      ok: false;
      requiresHold: true;
      reason: "unscheduled" | "wrong_time" | "over_logged";
      message: string;
      values: HourLogFormValues;
    }
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
    // A named submit button ("Send to admin for approval") puts this pair in
    // the FormData; a normal "Log work" submit omits it, so the anomaly is
    // re-checked on every plain submit.
    acknowledgeHold: formData.get("acknowledgeHold")?.toString() === "true",
  };
}

function translate(
  err: unknown,
  values: HourLogFormValues,
): HourLogActionResult {
  // Anomalous manual log, not yet acknowledged → warning variant carrying the
  // specific issue + the coach's entered values (echoed back into the fields).
  if (err instanceof HeldLogReviewRequiredError) {
    return {
      ok: false,
      requiresHold: true,
      reason: err.reason,
      message: err.message,
      values,
    };
  }
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
  const acknowledgeHold =
    formData.get("acknowledgeHold")?.toString() === "true";
  try {
    await logOwnHour(buildInput(formData));
    // When the coach acknowledged a hold, the write created a HELD row →
    // confirm it was sent for approval rather than posted.
    return { ok: true, loggedAt: Date.now(), held: acknowledgeHold };
  } catch (err) {
    return translate(err, values);
  }
}
