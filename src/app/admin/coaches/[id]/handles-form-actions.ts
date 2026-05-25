"use server";

// useActionState wrapper for the handles editor on /admin/coaches/[id].
// Same pattern as the rate-override form-actions: snapshot the typed
// values so a Zod failure remounts the form with what the admin had
// in flight, instead of blanking the inputs.

import { ZodError } from "zod";
import { updateCoachHandles } from "./actions";
import { CoachNotFoundError } from "@/lib/errors";

export type HandlesFormValues = {
  zelleContact: string;
};

export type HandlesActionResult =
  | { ok: true }
  | {
      ok: false;
      error: { code: string; message: string };
      values: HandlesFormValues;
    };

function snapshot(formData: FormData): HandlesFormValues {
  return {
    zelleContact: formData.get("zelleContact")?.toString() ?? "",
  };
}

function translate(err: unknown, values: HandlesFormValues): HandlesActionResult {
  if (err instanceof CoachNotFoundError) {
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
        message: first?.message ?? "Invalid input",
      },
      values,
    };
  }
  throw err;
}

export async function updateCoachHandlesFormAction(
  _prev: HandlesActionResult,
  formData: FormData,
): Promise<HandlesActionResult> {
  const values = snapshot(formData);
  const userId = formData.get("userId")?.toString();
  if (!userId) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "Missing user id" },
      values,
    };
  }
  try {
    await updateCoachHandles({
      userId,
      // Send empty strings as "clear this column" rather than "leave
      // unchanged" — the schema coerces "" → null after Zod's transform.
      zelleContact: values.zelleContact,
    });
    return { ok: true };
  } catch (err) {
    return translate(err, values);
  }
}
