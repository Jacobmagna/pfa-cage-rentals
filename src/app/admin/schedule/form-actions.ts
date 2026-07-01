"use server";

// useActionState wrapper for the Block tab of the grid's create
// dialog + plain delete-block server action. Same translation
// pattern as admin/sessions/form-actions.ts — typed errors → red
// banner copy, anything else re-thrown to the Next error boundary.

import { ZodError } from "zod";
import { deleteBlock, updateBlock } from "./actions";
import { BlockNotFoundError } from "@/lib/errors";

// Revalidation invariant: ./actions.ts owns revalidatePath for the
// schedule surface. These wrappers focus on FormData translation +
// typed-error → banner-copy mapping only.
import {
  BlockConflictsWithSessionError,
  BlockOverlapError,
  ResourceNotFoundError,
} from "@/lib/errors";
import { parsePfaInput } from "@/lib/timezone";

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
    startAt: parsePfaInput(dateStr, startStr),
    endAt: parsePfaInput(dateStr, endStr),
    reason: formData.get("reason")?.toString().trim() ?? "",
  };
}

function translate(err: unknown, values: BlockFormValues): BlockActionResult {
  if (
    err instanceof BlockOverlapError ||
    err instanceof BlockConflictsWithSessionError ||
    err instanceof ResourceNotFoundError ||
    err instanceof BlockNotFoundError
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

export async function updateBlockFormAction(
  _prev: BlockActionResult,
  formData: FormData,
): Promise<BlockActionResult> {
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
    await updateBlock(id, buildInput(formData));
    return { ok: true };
  } catch (err) {
    return translate(err, values);
  }
}

export async function deleteBlockAction(id: string): Promise<void> {
  await deleteBlock(id);
}
