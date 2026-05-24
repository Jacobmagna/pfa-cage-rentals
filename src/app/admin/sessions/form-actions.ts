"use server";

// Form-action wrappers for the C6 server actions. The raw actions
// throw typed errors (SessionOverlapError, BlockedTimeError, etc.);
// useActionState wants a stable return shape so the dialog can
// render error banners without try/catch in the client component.
//
// These translate the typed errors into a discriminated-union
// result shape. Unknown errors still throw — Next.js error
// boundaries + Sentry catch them, which is the right default for
// "this is a bug, not a user-correctable conflict".

import { ZodError } from "zod";
import {
  createSession,
  deleteSession,
  updateSession,
} from "./actions";

// Revalidation invariant: the public actions in ./actions.ts now own
// revalidatePath for the session surfaces. These wrappers focus on
// FormData translation + typed-error → banner-copy mapping only.
import {
  BlockedTimeError,
  ResourceNotFoundError,
  SessionNotFoundError,
  SessionOverlapError,
  UseTypeValidationError,
} from "@/lib/errors";

export type SubmittedFormValues = {
  coachId: string;
  resourceId: string;
  date: string;
  startTime: string;
  endTime: string;
  useType: string;
  note: string;
};

export type ActionResult =
  | { ok: true }
  | {
      ok: false;
      error: { code: string; message: string };
      values: SubmittedFormValues;
    };

// Snapshot the form's raw values so we can re-render the form
// pre-filled when the action errors. Without this, the user has to
// re-pick coach/resource/date/etc. after every overlap conflict.
function snapshotFormValues(formData: FormData): SubmittedFormValues {
  return {
    coachId: formData.get("coachId")?.toString() ?? "",
    resourceId: formData.get("resourceId")?.toString() ?? "",
    date: formData.get("date")?.toString() ?? "",
    startTime: formData.get("startTime")?.toString() ?? "",
    endTime: formData.get("endTime")?.toString() ?? "",
    useType: formData.get("useType")?.toString() ?? "",
    note: formData.get("note")?.toString() ?? "",
  };
}

// Maps FormData → the shape createSessionSchema expects. Combines
// the date input and two time inputs into Date objects.
function buildSessionInput(formData: FormData) {
  const dateStr = formData.get("date")?.toString().trim();
  const startStr = formData.get("startTime")?.toString().trim();
  const endStr = formData.get("endTime")?.toString().trim();
  if (!dateStr || !startStr || !endStr) {
    throw new Error("Missing date, start, or end time");
  }
  const startAt = new Date(`${dateStr}T${startStr}:00`);
  const endAt = new Date(`${dateStr}T${endStr}:00`);
  const useTypeRaw = formData.get("useType")?.toString().trim();
  return {
    coachId: formData.get("coachId")?.toString() ?? "",
    resourceId: formData.get("resourceId")?.toString() ?? "",
    startAt,
    endAt,
    // Send `null` (not undefined) for empty values so the UPDATE path
    // actually clears the column. updateSessionInternal treats
    // undefined as "don't touch this column" and null as "set to NULL"
    // — using undefined here previously caused silent no-ops when an
    // admin tried to remove a note or switch a cage's useType to
    // "— None". Create path is unaffected (the internal coerces
    // undefined/null to null at insert).
    useType:
      useTypeRaw === "hitting" || useTypeRaw === "pitching"
        ? useTypeRaw
        : null,
    note: formData.get("note")?.toString().trim() || null,
  };
}

function translateError(
  err: unknown,
  values: SubmittedFormValues,
): ActionResult {
  if (
    err instanceof SessionOverlapError ||
    err instanceof BlockedTimeError ||
    err instanceof UseTypeValidationError ||
    err instanceof SessionNotFoundError ||
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
  // Unknown — let Next.js error boundary + Sentry handle it.
  throw err;
}

export async function createSessionFormAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const values = snapshotFormValues(formData);
  try {
    await createSession(buildSessionInput(formData));
    return { ok: true };
  } catch (err) {
    return translateError(err, values);
  }
}

export async function updateSessionFormAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const values = snapshotFormValues(formData);
  const id = formData.get("id")?.toString();
  if (!id) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "Missing session id" },
      values,
    };
  }
  try {
    await updateSession(id, buildSessionInput(formData));
    return { ok: true };
  } catch (err) {
    return translateError(err, values);
  }
}

// Delete doesn't use useActionState — confirm() dialog + simple
// button. Revalidation happens inside the public deleteSession action.
export async function deleteSessionAction(id: string): Promise<void> {
  await deleteSession(id);
}
