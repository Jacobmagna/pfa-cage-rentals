"use server";

// useActionState wrappers for the coach edit dialog + a thin delete
// wrapper that revalidates the history page on success. Mirrors the
// admin pattern in src/app/admin/sessions/form-actions.ts but with
// the coach-side ownership-gated actions.

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import {
  deleteOwnSession,
  requestOwnSessionRemoval,
  updateOwnSession,
} from "./actions";
import {
  BlockedTimeError,
  ResourceNotFoundError,
  SessionNotFoundError,
  SessionOverlapError,
} from "@/lib/errors";
import { parsePfaInput } from "@/lib/timezone";

export type EditFormValues = {
  resourceId: string;
  date: string;
  startTime: string;
  endTime: string;
  note: string;
};

export type EditActionResult =
  | { ok: true }
  | {
      ok: false;
      error: { code: string; message: string };
      values: EditFormValues;
    };

function snapshot(formData: FormData): EditFormValues {
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

function translate(err: unknown, values: EditFormValues): EditActionResult {
  if (
    err instanceof SessionOverlapError ||
    err instanceof BlockedTimeError ||
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
  throw err;
}

export async function updateOwnSessionFormAction(
  _prev: EditActionResult,
  formData: FormData,
): Promise<EditActionResult> {
  const values = snapshot(formData);
  const id = formData.get("id")?.toString();
  if (!id) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "Missing session id" },
      values,
    };
  }
  try {
    await updateOwnSession(id, buildInput(formData));
    revalidatePath("/coach/sessions");
    return { ok: true };
  } catch (err) {
    return translate(err, values);
  }
}

// Plain server action for delete (no useActionState — confirm() in
// the client component is the UX). revalidate triggers the page to
// re-fetch the list after the row is gone.
export async function deleteOwnSessionAction(id: string): Promise<void> {
  await deleteOwnSession(id);
  revalidatePath("/coach/sessions");
}

// 1b security: a coach files a removal request for a PAST rental (it can't
// be deleted/edited-billable directly). The underlying action already
// revalidates the coach + admin surfaces; this thin wrapper exists so the
// client component calls a local server action with the simple
// (id, reason) shape its dialog produces.
export async function requestOwnSessionRemovalAction(
  id: string,
  reason: string | null,
): Promise<void> {
  await requestOwnSessionRemoval(id, reason);
}
