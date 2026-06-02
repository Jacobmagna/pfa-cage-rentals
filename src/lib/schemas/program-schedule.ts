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
  scheduledCoachId: z.string().min(1, "scheduledCoachId is required"),
  startAt: z.coerce.date(),
  endAt: z.coerce.date(),
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
