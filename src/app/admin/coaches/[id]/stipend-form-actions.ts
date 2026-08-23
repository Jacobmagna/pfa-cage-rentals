"use server";

// useActionState wrappers for the coach-detail STIPEND card (SPEC §6, Phase C).
//
// Same shape as the handles / notes / rate-override form-actions: snapshot the
// typed values so a failure remounts the form with what the admin had in
// flight instead of blanking it.
//
// ── 🔴 THE ONE THING THIS FILE DOES THAT THE OTHERS DO NOT ─────────────────
// It translates `StipendPlanError` with code `BACKDATE_NOT_CONFIRMED` into a
// DISTINCT result shape (`needsBackdateConfirm`) rather than a plain error
// banner. That is not cosmetic. §12.4's risk is the app newly claiming money
// is owed that Mark may already have settled in cash, and the whole control is
// that a human reads which periods are affected and what they cost BEFORE the
// row is written. A generic red banner would train an admin to re-submit
// without reading it.
//
// The confirm is a SECOND submit carrying `confirmBackdate`, exactly like the
// re-price decrease flow — the server recomputes the affected periods itself
// and never trusts a caller-supplied list.

import { ZodError } from "zod";
import { CoachArchivedError, CoachNotFoundError } from "@/lib/errors";
import { dollarsToCents } from "@/lib/schemas/stipend";
import { StipendPlanError } from "@/lib/stipend/engine";
import { parsePfaInput } from "@/lib/timezone";
import { cancelCoachStipend, endCoachStipend, setCoachStipend } from "./actions";

export type StipendFormValues = {
  /** Dollars as typed, e.g. "2500" or "2500.00". Never cents at this layer. */
  amount: string;
  /** ISO date of a pay-period start, e.g. "2026-09-01". */
  effectiveFrom: string;
  note: string;
};

export type StipendActionResult =
  | { ok: true }
  | {
      ok: false;
      /** 🔴 The §12.4 back-pay case — a confirmation, not a validation error. */
      needsBackdateConfirm: true;
      message: string;
      periodKeys: string[];
      values: StipendFormValues;
    }
  | {
      ok: false;
      needsBackdateConfirm?: false;
      error: { code: string; message: string };
      values: StipendFormValues;
    };

const EMPTY_VALUES: StipendFormValues = {
  amount: "",
  effectiveFrom: "",
  note: "",
};

function readValues(formData: FormData): StipendFormValues {
  return {
    amount: formData.get("amount")?.toString() ?? "",
    effectiveFrom: formData.get("effectiveFrom")?.toString() ?? "",
    note: formData.get("note")?.toString() ?? "",
  };
}

function translate(
  err: unknown,
  values: StipendFormValues,
): StipendActionResult {
  // 🔴 The back-pay confirmation, split out before the generic branch.
  if (err instanceof StipendPlanError && err.code === "BACKDATE_NOT_CONFIRMED") {
    return {
      ok: false,
      needsBackdateConfirm: true,
      message: err.message,
      periodKeys: err.backdatedPeriods.map((p) => p.key),
      values,
    };
  }
  if (err instanceof StipendPlanError) {
    return {
      ok: false,
      error: { code: err.code, message: err.message },
      values,
    };
  }
  if (err instanceof CoachNotFoundError || err instanceof CoachArchivedError) {
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
      error: { code: "VALIDATION", message: first?.message ?? "Invalid input" },
      values,
    };
  }
  throw err;
}

export async function setCoachStipendFormAction(
  _prev: StipendActionResult,
  formData: FormData,
): Promise<StipendActionResult> {
  const values = readValues(formData);
  const coachId = formData.get("coachId")?.toString();
  if (!coachId) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "Missing coach id" },
      values,
    };
  }

  const amountCents = dollarsToCents(values.amount);
  if (amountCents === null) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Enter a dollar amount, like 2500 or 2500.00",
      },
      values,
    };
  }

  // 🔴 The card posts a date-only string. Parsed as a PFA wall-clock midnight,
  // NOT `new Date(str)` — that reads it as UTC midnight, which is 5pm the
  // PREVIOUS PFA day, and would land the stipend a whole pay period early
  // every time the date is the 1st or the 16th. Which is always.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.effectiveFrom)) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "Pick a start date" },
      values,
    };
  }
  const effectiveFrom = parsePfaInput(values.effectiveFrom, "00:00");

  try {
    await setCoachStipend({
      coachId,
      amountCents,
      effectiveFrom,
      note: values.note.trim() === "" ? null : values.note.trim(),
      confirmBackdate: formData.get("confirmBackdate")?.toString() === "true",
    });
    return { ok: true };
  } catch (err) {
    return translate(err, values);
  }
}

export async function endCoachStipendFormAction(
  _prev: StipendActionResult,
  formData: FormData,
): Promise<StipendActionResult> {
  const coachId = formData.get("coachId")?.toString();
  const effectiveTo = formData.get("effectiveTo")?.toString() ?? "";
  const values: StipendFormValues = { ...EMPTY_VALUES, effectiveFrom: effectiveTo };

  if (!coachId) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "Missing coach id" },
      values,
    };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveTo)) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "Pick an end date" },
      values,
    };
  }

  try {
    await endCoachStipend({
      coachId,
      effectiveTo: parsePfaInput(effectiveTo, "00:00"),
      confirmBackdate: formData.get("confirmBackdate")?.toString() === "true",
    });
    return { ok: true };
  } catch (err) {
    return translate(err, values);
  }
}

/**
 * Cancel a not-yet-started stipend.
 *
 * No date, no confirmation step: the planner decides which versions qualify
 * (every one whose pay period has not begun) and there is nothing to confirm
 * because nothing can have been earned against them. If the stipend HAS
 * started, the planner refuses with `ALREADY_STARTED` and the admin is told to
 * end it from a future period instead.
 */
export async function cancelCoachStipendFormAction(
  _prev: StipendActionResult,
  formData: FormData,
): Promise<StipendActionResult> {
  const coachId = formData.get("coachId")?.toString();
  if (!coachId) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "Missing coach id" },
      values: EMPTY_VALUES,
    };
  }

  try {
    await cancelCoachStipend({ coachId });
    return { ok: true };
  } catch (err) {
    return translate(err, EMPTY_VALUES);
  }
}
