"use server";

// useActionState wrapper for the coach log-session form. The raw
// action (logOwnSession) throws typed errors; this layer translates
// them into a discriminated-union result so the client can render
// banners without try/catch.
//
// On success, returns a nonce (timestamp) the client uses to key
// the form's remount → fresh defaults for the next submission.

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { logOwnSession } from "../actions";
import {
  BlockedTimeError,
  ResourceNotFoundError,
  SessionOverlapError,
} from "@/lib/errors";
import { parsePfaInput } from "@/lib/timezone";

export type CoachFormValues = {
  resourceId: string;
  date: string;
  startTime: string;
  endTime: string;
  note: string;
};

export type CoachActionResult =
  | { ok: true; loggedAt: number }
  | {
      ok: false;
      error: { code: string; message: string };
      values: CoachFormValues;
    };

function snapshot(formData: FormData): CoachFormValues {
  return {
    resourceId: formData.get("resourceId")?.toString() ?? "",
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
    resourceId: formData.get("resourceId")?.toString() ?? "",
    startAt,
    endAt,
    note: formData.get("note")?.toString().trim() || null,
  };
}

function translate(err: unknown, values: CoachFormValues): CoachActionResult {
  if (
    err instanceof SessionOverlapError ||
    err instanceof BlockedTimeError ||
    err instanceof ResourceNotFoundError
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

export async function logOwnSessionFormAction(
  _prev: CoachActionResult,
  formData: FormData,
): Promise<CoachActionResult> {
  const values = snapshot(formData);
  try {
    await logOwnSession(buildInput(formData));
    revalidatePath("/coach");
    return { ok: true, loggedAt: Date.now() };
  } catch (err) {
    return translate(err, values);
  }
}
