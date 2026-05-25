"use server";

// useActionState wrapper for the org-settings form on /admin/settings.
// Mirrors the coach handles form-action pattern.

import { ZodError } from "zod";
import { updateOrgSettings } from "./actions";

export type OrgSettingsFormValues = {
  pfaDisplayName: string;
  pfaZelleContact: string;
};

export type OrgSettingsActionResult =
  | { ok: true }
  | {
      ok: false;
      error: { code: string; message: string };
      values: OrgSettingsFormValues;
    };

function snapshot(formData: FormData): OrgSettingsFormValues {
  return {
    pfaDisplayName: formData.get("pfaDisplayName")?.toString() ?? "",
    pfaZelleContact: formData.get("pfaZelleContact")?.toString() ?? "",
  };
}

function translate(
  err: unknown,
  values: OrgSettingsFormValues,
): OrgSettingsActionResult {
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

export async function updateOrgSettingsFormAction(
  _prev: OrgSettingsActionResult,
  formData: FormData,
): Promise<OrgSettingsActionResult> {
  const values = snapshot(formData);
  try {
    await updateOrgSettings({
      pfaDisplayName: values.pfaDisplayName,
      pfaZelleContact: values.pfaZelleContact,
    });
    return { ok: true };
  } catch (err) {
    return translate(err, values);
  }
}
