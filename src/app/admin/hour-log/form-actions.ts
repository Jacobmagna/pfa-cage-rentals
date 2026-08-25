"use server";

// Form-action wrapper for the admin hour-log edit dialog. The raw
// action (updateHour) throws typed errors (HourLogNotFoundError,
// ZodError, etc.); useActionState wants a stable return shape so the
// dialog can render error banners without try/catch in the client.
//
// Mirrors admin/sessions/form-actions.ts: snapshot the submitted
// values so the form re-renders pre-filled on error, build the schema
// input from FormData, translate typed errors into a discriminated
// union, rethrow unknown errors (Next.js error boundary + Sentry).
//
// The edit dialog only changes times + note; programId rides along as
// a hidden field so editHourLogSchema (which requires it) parses. We
// still map ProgramInactiveError / ProgramNotFoundError defensively in
// case a stale program id surfaces.

import { ZodError } from "zod";
import { deleteHour, logHourForCoach, updateHour } from "./actions";
import {
  AdminHourEntryNotConfirmedError,
  HourLogNotFoundError,
  HourLogSubjectNotFoundError,
  ProgramInactiveError,
  ProgramNotFoundError,
} from "@/lib/errors";
import type { AdminHourEntryWarning } from "@/lib/admin-hour-entry";
import type { ScheduleSyncOutcome } from "@/lib/server/admin-entry-schedule-sync";
import { parsePfaInput } from "@/lib/timezone";

export type SubmittedHourValues = {
  programId: string;
  date: string;
  startTime: string;
  endTime: string;
  note: string;
};

export type HourActionResult =
  | { ok: true }
  | {
      ok: false;
      error: { code: string; message: string };
      values: SubmittedHourValues;
    };

// Snapshot the form's raw values so we can re-render pre-filled when
// the action errors — without this the admin re-types the time/note
// after every validation failure.
function snapshotFormValues(formData: FormData): SubmittedHourValues {
  return {
    programId: formData.get("programId")?.toString() ?? "",
    date: formData.get("date")?.toString() ?? "",
    startTime: formData.get("startTime")?.toString() ?? "",
    endTime: formData.get("endTime")?.toString() ?? "",
    note: formData.get("note")?.toString() ?? "",
  };
}

// Maps FormData → the shape editHourLogSchema expects. Combines the
// date input and two time inputs into UTC Date instants.
function buildHourInput(formData: FormData) {
  const dateStr = formData.get("date")?.toString().trim();
  const startStr = formData.get("startTime")?.toString().trim();
  const endStr = formData.get("endTime")?.toString().trim();
  if (!dateStr || !startStr || !endStr) {
    throw new Error("Missing date, start, or end time");
  }
  const startAt = parsePfaInput(dateStr, startStr);
  const endAt = parsePfaInput(dateStr, endStr);
  return {
    programId: formData.get("programId")?.toString() ?? "",
    startAt,
    endAt,
    note: formData.get("note")?.toString().trim() || null,
  };
}

function translateError(
  err: unknown,
  values: SubmittedHourValues,
): HourActionResult {
  if (
    err instanceof HourLogNotFoundError ||
    err instanceof ProgramInactiveError ||
    err instanceof ProgramNotFoundError
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
  // Unknown — let Next.js error boundary + Sentry handle it.
  throw err;
}

export async function updateHourFormAction(
  _prev: HourActionResult,
  formData: FormData,
): Promise<HourActionResult> {
  const values = snapshotFormValues(formData);
  const id = formData.get("id")?.toString();
  if (!id) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "Missing hour-log id" },
      values,
    };
  }
  try {
    await updateHour(id, buildHourInput(formData));
    return { ok: true };
  } catch (err) {
    return translateError(err, values);
  }
}

// Delete doesn't use useActionState — ConfirmDialog + a simple button.
// Revalidation happens inside the public deleteHour action.
export async function deleteHourAction(id: string): Promise<void> {
  await deleteHour(id);
}

// ─────────────────────────────────────────────────────────────────────────
// ADMIN HOUR ENTRY — "Log hours for a coach"
// ─────────────────────────────────────────────────────────────────────────
//
// Same shape as the edit wrapper above (snapshot the values, build the schema
// input, translate typed errors) with ONE addition that carries the whole
// design: a result can come back as a DECISION rather than an error.
//
// 🔴 WHY A DECISION IS NOT AN ERROR. `AdminHourEntryNotConfirmedError` means
// the entry is probably fine and the admin should see something first — an
// overlapping log, or a period already paid out. Rendering that in the red
// error banner would teach him that the save is broken, and he would either
// stop using the feature or learn to ignore red banners on a payroll screen.
// It is the same distinction the stipend card draws for the §12.4 back-pay
// refusal: an amber decision with a button that goes ahead, not a failure.

export type LogHoursForCoachValues = {
  /** Every coach ticked on the form, so a re-render re-ticks the same boxes. */
  coachIds: string[];
  programId: string;
  date: string;
  startTime: string;
  endTime: string;
  note: string;
};

export type LogHoursForCoachResult =
  /**
   * Written. `notice` is non-null ONLY when the hours were recorded but the
   * SCHEDULE could not be updated to match — a retired program has no
   * schedule to add to, or the block write failed after the pay was already
   * committed. The dialog closes on a plain success and stays open to show a
   * notice, because "we paid them but the schedule still says no-show" is a
   * fact an admin has to be told once; a screen that closes on it teaches him
   * the grid is unreliable.
   */
  | { ok: true; notice: string | null }
  /** Something is wrong and the admin must change the form to proceed. */
  | {
      ok: false;
      kind: "error";
      error: { code: string; message: string };
      values: LogHoursForCoachValues;
    }
  /**
   * Nothing is wrong; there is something the admin should know before this
   * is written. Re-submitting with `confirm=true` goes ahead.
   */
  | {
      ok: false;
      kind: "decision";
      warnings: AdminHourEntryWarning[];
      values: LogHoursForCoachValues;
    };

/**
 * The sentence to show when the schedule did not end up matching the hours.
 * `null` for every outcome that needs no explanation — the block was joined,
 * created, or already correct — because a notice that fires on success is a
 * notice people learn to click past.
 */
function scheduleNotice(outcome: ScheduleSyncOutcome): string | null {
  return outcome.kind === "skipped" ? outcome.detail : null;
}

function snapshotLogHoursValues(formData: FormData): LogHoursForCoachValues {
  return {
    // getAll — the coach picker is a checkbox group now, and `get` would
    // silently keep only the first person ticked.
    coachIds: formData.getAll("coachIds").map((v) => v.toString()),
    programId: formData.get("programId")?.toString() ?? "",
    date: formData.get("date")?.toString() ?? "",
    startTime: formData.get("startTime")?.toString() ?? "",
    endTime: formData.get("endTime")?.toString() ?? "",
    note: formData.get("note")?.toString() ?? "",
  };
}

export async function logHoursForCoachFormAction(
  _prev: LogHoursForCoachResult,
  formData: FormData,
): Promise<LogHoursForCoachResult> {
  const values = snapshotLogHoursValues(formData);
  try {
    const base = buildHourInput(formData);
    const result = await logHourForCoach({
      ...base,
      coachIds: values.coachIds,
      // Carried by the "Record these hours anyway" submit button's own
      // name/value — only the CLICKED submit is serialized, so there is no
      // hidden field to leave stale and no way for a plain re-submit to
      // silently inherit a previous confirmation.
      confirmWarnings: formData.get("confirm")?.toString() === "true",
    });
    return { ok: true, notice: scheduleNotice(result.schedule) };
  } catch (err) {
    if (err instanceof AdminHourEntryNotConfirmedError) {
      return { ok: false, kind: "decision", warnings: [...err.warnings], values };
    }
    if (
      err instanceof HourLogSubjectNotFoundError ||
      err instanceof ProgramNotFoundError ||
      err instanceof ProgramInactiveError
    ) {
      return {
        ok: false,
        kind: "error",
        error: { code: err.code, message: err.message },
        values,
      };
    }
    if (err instanceof ZodError) {
      const first = err.issues[0];
      // 🔴 The coach list's own message is written FOR the admin ("Pick at
      // least one coach"), so it is shown as-is. Prefixing it with the field
      // name would print `coachIds:` at a non-technical reader and point him
      // at a thing on no screen — the F7 defect the stipend review filed.
      const isCoachList = first?.path[0] === "coachIds";
      return {
        ok: false,
        kind: "error",
        error: {
          code: "VALIDATION",
          message: !first
            ? "Invalid input"
            : isCoachList
              ? first.message
              : `${first.path.join(".")}: ${first.message}`,
        },
        values,
      };
    }
    // Unknown — let Next.js error boundary + Sentry handle it.
    throw err;
  }
}
