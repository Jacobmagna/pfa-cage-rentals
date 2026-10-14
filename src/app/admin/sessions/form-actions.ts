"use server";

// Form-action wrappers for the C6 server actions. The raw actions
// throw typed errors (SessionOverlapError, BlockedTimeError,
// WeightRoomMinimumError, etc.);
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
  createSessionsBatch,
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
  WeightRoomMinimumError,
} from "@/lib/errors";
import { parsePfaInput } from "@/lib/timezone";

export type SubmittedFormValues = {
  coachId: string;
  resourceId: string;
  date: string;
  startTime: string;
  endTime: string;
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
  const startAt = parsePfaInput(dateStr, startStr);
  const endAt = parsePfaInput(dateStr, endStr);
  return {
    coachId: formData.get("coachId")?.toString() ?? "",
    resourceId: formData.get("resourceId")?.toString() ?? "",
    startAt,
    endAt,
    // Booking-level group-session flag. No admin dialog sends it any more
    // (the Session tab's checkbox and hidden field are gone); an old payload
    // that still carries it is passed along here, but the server no longer
    // acts on it: a new booking is always saved
    // is_group_session=false at the regular rate (createSessionInternal), and
    // an edit takes the flag from the stored row (updateSessionInternal).
    // Defaults false when absent.
    isGroupSession: formData.get("isGroupSession")?.toString() === "true",
    // Send `null` (not undefined) for an empty note so the UPDATE path
    // actually clears the column. updateSessionInternal treats undefined
    // as "don't touch this column" and null as "set to NULL" — using
    // undefined here previously caused silent no-ops when an admin tried
    // to remove a note. Create path is unaffected (the internal coerces
    // undefined/null to null at insert).
    note: formData.get("note")?.toString().trim() || null,
  };
}

// The allow-list: the typed errors a user can act on, turned into the code
// and sentence the screen shows. Anything else is rethrown — Next.js error
// boundary + Sentry handle it ("this is a bug, not a user-correctable
// conflict"). Shared by the form actions and moveSessionAction so there is
// one list.
function translateKnownError(err: unknown): { code: string; message: string } {
  if (
    err instanceof SessionOverlapError ||
    err instanceof BlockedTimeError ||
    err instanceof WeightRoomMinimumError ||
    err instanceof SessionNotFoundError ||
    err instanceof ResourceNotFoundError
  ) {
    return { code: err.code, message: err.message };
  }
  if (err instanceof ZodError) {
    const first = err.issues[0];
    return {
      code: "VALIDATION",
      message: first
        ? `${first.path.join(".")}: ${first.message}`
        : "Invalid input",
    };
  }
  // Unknown — let Next.js error boundary + Sentry handle it.
  throw err;
}

function translateError(
  err: unknown,
  values: SubmittedFormValues,
): ActionResult {
  return { ok: false, error: translateKnownError(err), values };
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

export type MoveSessionResult =
  | { ok: true }
  | { ok: false; error: { code: string; message: string } };

// Drag-and-drop move on the two admin grids (the day grid, also mounted at
// /master/schedule, and the admin Home master schedule). Same write and same
// authorization as before — it calls the very same public updateSession
// (requireScheduleAccess, then updateSessionInternal) with only the new
// resource, start and end. The difference is that a refusal comes back as a
// RESULT, not a throw: a production build strips the message from a thrown
// server-action error, so the grid could only ever show the framework's
// "An error occurred in the Server Components render…" sentence. A known
// refusal (overlap, block, weight room minimum, …) now reaches the screen as
// its real sentence. Anything else, including the auth redirect, still throws.
export async function moveSessionAction(
  id: string,
  input: {
    resourceId: string;
    startAt: Date | string;
    endAt: Date | string;
  },
): Promise<MoveSessionResult> {
  try {
    await updateSession(id, {
      resourceId: input?.resourceId,
      startAt: input?.startAt,
      endAt: input?.endAt,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: translateKnownError(err) };
  }
}

export type CreateSessionsBatchResult =
  | { ok: true; count: number }
  | { ok: false; error: { code: string; message: string } };

// Multi-slot create on the two admin dialogs (the create dialog's Session
// tab on the day grid, /master/schedule and admin Home; SessionFormDialog in
// create mode on Rentals). Same write and same authorization as before — it
// calls the very same public createSessionsBatch (requireScheduleAccess,
// then createSessionsBatchInternal). The difference is that a refusal comes
// back as a RESULT, not a throw: a production build strips the message from
// a thrown server-action error, so the dialogs could only ever show the
// framework's "An error occurred in the Server Components render…" sentence
// (a cage overlap showed it). A known refusal now reaches the screen as its
// real sentence. Anything else, including the auth redirect, still throws.
// `count` is the rentals saved (back-to-back weight room slots are one).
export async function createSessionsBatchAction(
  input: unknown,
): Promise<CreateSessionsBatchResult> {
  try {
    const saved = await createSessionsBatch(input);
    return { ok: true, count: saved.length };
  } catch (err) {
    return { ok: false, error: translateKnownError(err) };
  }
}

// Delete doesn't use useActionState — confirm() dialog + simple
// button. Revalidation happens inside the public deleteSession action.
export async function deleteSessionAction(id: string): Promise<void> {
  await deleteSession(id);
}
