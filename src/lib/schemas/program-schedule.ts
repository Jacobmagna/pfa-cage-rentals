// Zod schemas for program-schedule-block mutations. Mirrors block.ts +
// the hour-log refine: startAt/endAt use z.coerce.date() so ISO strings
// from forms become real Dates, and endAt > startAt is validated here
// AND by the DB CHECK constraint (the DB is canonical; this gives a
// friendly error). `note` is optional free text, capped at 200 chars.
//
// Cross-cutting business rules (program-active, coach-is-coach) live in
// the server action, not here — same philosophy as block.ts.

import { z } from "zod";

const programScheduleBlockShape = {
  programId: z.string().min(1, "programId is required"),
  // QA10 W3.2: the FULL set of scheduled coaches (primary = [0]). The
  // action dedupes + validates each id.
  // QA-R2 #10: coach assignment is OPTIONAL — an empty array means
  // "no coach assigned" (the block renders as Unassigned). Inner
  // z.string().min(1) still rejects any blank id that IS provided.
  scheduledCoachIds: z.array(z.string().min(1)),
  startAt: z.coerce.date(),
  endAt: z.coerce.date(),
  // QA10 W3.3: the cage resources this program block OCCUPIES. CREATE
  // treats `resourceIds ?? []`; UPDATE treats `undefined` = "leave
  // occupancy untouched" and a present array (incl. []) = "replace the set".
  resourceIds: z.array(z.string().min(1)).optional(),
  note: z.string().max(200, "Note is at most 200 characters").nullish(),
};

const base = z.object(programScheduleBlockShape);

const endAfterStartError = {
  message: "endAt must be after startAt",
  path: ["endAt"],
};

// Create: both startAt + endAt are always present, so refine straight.
export const createProgramScheduleBlockSchema = base.refine(
  (v) => v.startAt < v.endAt,
  endAfterStartError,
);

// Update: every field optional (the action treats `undefined` as "don't
// touch this column"). The end>start refine is guarded so it only fires
// when BOTH start + end are present in the partial payload — a partial
// update that touches only one side can't be validated here (the action
// merges against the existing row; the DB CHECK is the backstop).
export const updateProgramScheduleBlockSchema = base
  .partial()
  .refine(
    (v) => !(v.startAt && v.endAt) || v.startAt < v.endAt,
    endAfterStartError,
  );

export type CreateProgramScheduleBlockInput = z.infer<
  typeof createProgramScheduleBlockSchema
>;
export type UpdateProgramScheduleBlockInput = z.infer<
  typeof updateProgramScheduleBlockSchema
>;

// ---------------------------------------------------------------------------
// RECUR-a: recurring program-schedule SERIES schemas.
//
// A series is a weekly recurrence definition that the action layer
// materializes into one program_schedule_blocks row per occurrence.
// Validation mirrors the block schema: structural/format rules live here,
// cross-cutting business rules (program-active, coach-is-coach) and the
// occurrence-count cap live in the generator + action.
//
//  - daysOfWeek: 0=Sunday .. 6=Saturday (JS getUTCDay convention),
//    non-empty, deduped is left to the action/DB.
//  - startTime/endTime: zero-padded 24h "HH:MM" (the format TimeSelect
//    emits); start<end enforced here AND by the generator.
//  - startsOn/endsOn: "YYYY-MM-DD" PFA calendar dates (endsOn inclusive).

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const programScheduleSeriesShape = {
  programId: z.string().min(1, "programId is required"),
  // QA10 W3.2: full scheduled-coach set (primary = [0]).
  // QA-R2 #10: OPTIONAL — an empty array = no coach assigned.
  scheduledCoachIds: z.array(z.string().min(1)),
  daysOfWeek: z
    .array(z.number().int().min(0).max(6))
    .min(1, "Pick at least one weekday"),
  startTime: z.string().regex(TIME_RE, "startTime must be HH:MM (24h)"),
  endTime: z.string().regex(TIME_RE, "endTime must be HH:MM (24h)"),
  startsOn: z.string().regex(DATE_RE, "startsOn must be YYYY-MM-DD"),
  endsOn: z.string().regex(DATE_RE, "endsOn must be YYYY-MM-DD"),
  // RECUR-a recurrence frequency + interval. Both default to weekly/1 so
  // a payload omitting them reproduces today's weekly-every-week
  // behavior (back-compat). interval is coerced to an integer ≥ 1 (the
  // generator enforces the same invariant).
  frequency: z.enum(["weekly", "monthly"]).default("weekly"),
  interval: z.coerce
    .number()
    .int("interval must be a whole number")
    .min(1, "interval must be at least 1")
    .default(1),
  // QA10 W3.3: the cage resources every occurrence of this series OCCUPIES.
  // The series form sends the full set on each save; [] = no occupancy.
  resourceIds: z.array(z.string().min(1)).default([]),
  note: z.string().max(200, "Note is at most 200 characters").nullish(),
};

const seriesBase = z.object(programScheduleSeriesShape);

const seriesTimeError = {
  message: "startTime must be before endTime",
  path: ["endTime"],
};
const seriesDateError = {
  message: "startsOn must be on or before endsOn",
  path: ["endsOn"],
};

export const createProgramScheduleSeriesSchema = seriesBase
  .refine((v) => v.startTime < v.endTime, seriesTimeError)
  .refine((v) => v.startsOn <= v.endsOn, seriesDateError);

// Edit operates on the same editable fields. The materialize step
// (regenerate future occurrences) reads every field, so they are all
// required here too — the UI sends the full series definition on save.
export const editProgramScheduleSeriesSchema = seriesBase
  .refine((v) => v.startTime < v.endTime, seriesTimeError)
  .refine((v) => v.startsOn <= v.endsOn, seriesDateError);

export type CreateProgramScheduleSeriesInput = z.infer<
  typeof createProgramScheduleSeriesSchema
>;
export type EditProgramScheduleSeriesInput = z.infer<
  typeof editProgramScheduleSeriesSchema
>;
