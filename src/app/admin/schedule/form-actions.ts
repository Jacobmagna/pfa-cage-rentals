"use server";

// useActionState wrapper for the Block tab of the grid's create
// dialog + plain delete-block server action. Same translation
// pattern as admin/sessions/form-actions.ts — typed errors → red
// banner copy, anything else re-thrown to the Next error boundary.

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { createBlock, deleteBlock } from "./actions";
import {
  BlockConflictsWithSessionError,
  BlockOverlapError,
  ResourceNotFoundError,
} from "@/lib/errors";

export type BlockFormValues = {
  resourceId: string;
  date: string;
  startTime: string;
  endTime: string;
  reason: string;
};

export type BlockActionResult =
  | { ok: true }
  | {
      ok: false;
      error: { code: string; message: string };
      values: BlockFormValues;
    };

function snapshot(formData: FormData): BlockFormValues {
  return {
    resourceId: formData.get("resourceId")?.toString() ?? "",
    date: formData.get("date")?.toString() ?? "",
    startTime: formData.get("startTime")?.toString() ?? "",
    endTime: formData.get("endTime")?.toString() ?? "",
    reason: formData.get("reason")?.toString() ?? "",
  };
}

function buildInput(formData: FormData) {
  const dateStr = formData.get("date")?.toString().trim();
  const startStr = formData.get("startTime")?.toString().trim();
  const endStr = formData.get("endTime")?.toString().trim();
  if (!dateStr || !startStr || !endStr) {
    throw new Error("Missing date, start, or end time");
  }
  return {
    resourceId: formData.get("resourceId")?.toString() ?? "",
    startAt: new Date(`${dateStr}T${startStr}:00`),
    endAt: new Date(`${dateStr}T${endStr}:00`),
    reason: formData.get("reason")?.toString().trim() ?? "",
  };
}

function translate(err: unknown, values: BlockFormValues): BlockActionResult {
  if (
    err instanceof BlockOverlapError ||
    err instanceof BlockConflictsWithSessionError ||
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

export async function createBlockFormAction(
  _prev: BlockActionResult,
  formData: FormData,
): Promise<BlockActionResult> {
  const values = snapshot(formData);
  try {
    await createBlock(buildInput(formData));
    revalidatePath("/admin/schedule");
    return { ok: true };
  } catch (err) {
    return translate(err, values);
  }
}

export async function deleteBlockAction(id: string): Promise<void> {
  await deleteBlock(id);
  revalidatePath("/admin/schedule");
}
