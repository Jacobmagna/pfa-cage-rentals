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

// Weight room is entered + displayed PER HOUR, but all rates are stored
// per-30-min cents (billing reads per-30-min cents and never re-derives).
// Cage & bullpen are entered per-30-min. So convert ONLY the weight-room
// input from per-hour dollars → an equivalent per-30-min dollar string,
// using round(dollarsPerHour * 100 / 2) for the cents, then format back
// to a 2-decimal dollar string the downstream parser round-trips exactly.
// Mirrors the program-rate per-hour pattern. Non-numeric / blank input is
// passed through untouched so the existing downstream Zod + dollar-format
// validation owns the error messages.
function hourlyDollarsToCentsPer30Min(value: string): number {
  return Math.round(parseFloat(value) * 100 / 2);
}

function weightRoomHourlyToPer30MinDollars(value: string): string {
  const trimmed = value.trim();
  const stripped = trimmed.startsWith("$")
    ? trimmed.slice(1).trim()
    : trimmed;
  if (!/^\d+(\.\d{1,2})?$/.test(stripped)) {
    // Let the downstream validator produce the canonical error message.
    return value;
  }
  const cents = hourlyDollarsToCentsPer30Min(stripped);
  return (cents / 100).toFixed(2);
}

export async function updateRateDefaultsFormAction(
  _prev: RateDefaultsActionResult,
  formData: FormData,
): Promise<RateDefaultsActionResult> {
  const values = snapshotRates(formData);
  try {
    // Echo-back keeps the per-HOUR string the admin typed (values); only
    // the value sent downstream for storage is converted to per-30-min.
    await updateRateDefaults({
      cageDollars: values.cageDollars,
      bullpenDollars: values.bullpenDollars,
      weightRoomDollars: weightRoomHourlyToPer30MinDollars(
        values.weightRoomDollars,
      ),
    });
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
