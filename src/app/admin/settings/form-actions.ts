"use server";

// useActionState wrappers for /admin/settings forms.

import { ZodError } from "zod";
import { updateOrgSettings, updateRateDefaults } from "./actions";

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

export type RateDefaultsFormValues = {
  cageDollars: string;
  bullpenDollars: string;
  weightRoomDollars: string;
};

export type RateDefaultsActionResult =
  | { ok: true; savedAt: number }
  | {
      ok: false;
      error: { code: string; message: string };
      values: RateDefaultsFormValues;
    };

function snapshotRates(formData: FormData): RateDefaultsFormValues {
  return {
    cageDollars: formData.get("cageDollars")?.toString() ?? "",
    bullpenDollars: formData.get("bullpenDollars")?.toString() ?? "",
    weightRoomDollars: formData.get("weightRoomDollars")?.toString() ?? "",
  };
}

export async function updateRateDefaultsFormAction(
  _prev: RateDefaultsActionResult,
  formData: FormData,
): Promise<RateDefaultsActionResult> {
  const values = snapshotRates(formData);
  try {
    await updateRateDefaults(values);
    return { ok: true, savedAt: Date.now() };
  } catch (err) {
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
    if (err instanceof Error) {
      return {
        ok: false,
        error: { code: "INVALID_RATE", message: err.message },
        values,
      };
    }
    throw err;
  }
}
