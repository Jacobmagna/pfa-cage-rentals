"use server";

// useActionState wrappers for the coach edit dialog + a thin delete
// wrapper that revalidates the history page on success. Mirrors the
// admin pattern in src/app/admin/sessions/form-actions.ts but with
// the coach-side ownership-gated actions.

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { deleteOwnSession, updateOwnSession } from "./actions";
import {
  BlockedTimeError,
  ResourceNotFoundError,
  SessionNotFoundError,
  SessionOverlapError,
  UseTypeValidationError,
} from "@/lib/errors";
import { parsePfaInput } from "@/lib/timezone";

export type EditFormValues = {
  resourceId: string;
  date: string;
  startTime: string;
  endTime: string;
  useType: string;
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
    useType: formData.get("useType")?.toString() ?? "",
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
  const useTypeRaw = formData.get("useType")?.toString().trim();
  return {
    resourceId: formData.get("resourceId")?.toString() ?? "",
    startAt,
    endAt,
    useType:
      useTypeRaw === "hitting" || useTypeRaw === "pitching"
        ? useTypeRaw
        : null,
    note: formData.get("note")?.toString().trim() || null,
  };
}

function translate(err: unknown, values: EditFormValues): EditActionResult {
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
