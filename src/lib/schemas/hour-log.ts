// Zod schemas for coach hour-log mutations. startAt/endAt use
// z.coerce.date() (matching session.ts) so ISO strings from forms /
// JSON become real Dates. endAt > startAt is enforced here AND by the DB
// CHECK constraint; the DB is canonical, this gives a friendly error.

import { z } from "zod";

const hourLogShape = {
  programId: z.string().min(1, "programId is required"),
  startAt: z.coerce.date(),
  endAt: z.coerce.date(),
  note: z.string().max(2000).nullish(),
};

// 1b security B: create-only fields that drive the held-then-approve gate.
// Both OPTIONAL so existing callers are unaffected. `source` discriminates
// the trusted auto-confirm path ("schedule-confirm", never anomaly-checked)
// from manual entry (default, anomaly-checked); `acknowledgeHold` is the
// coach's "yes, send this anomalous log to an admin for approval" consent.
const createOnlyShape = {
  source: z.enum(["manual", "schedule-confirm"]).optional(),
  acknowledgeHold: z.boolean().optional(),
};

const endAfterStart = (v: { startAt: Date; endAt: Date }) =>
  v.startAt < v.endAt;
const endAfterStartError = {
  message: "endAt must be after startAt",
  path: ["endAt"],
};

// Upper bound on a single log's span. 16h is generous vs the 8 AM–10 PM
// facility window but catches a date typo that produces a 24h+ span.
// Zod-only — no DB constraint backs this (unlike endAt > startAt).
// 🔴 EXPORTED because a query depends on it, not just a refine. The admin
// overlap guard bounds its scan with `startAt > windowStart − this`, which is
// exact ONLY because no log may be longer than this. Raising it here without
// looking at that query would silently narrow the scan and let a long log slip
// past the double-pay check.
export const MAX_HOUR_LOG_DURATION_MS = 16 * 60 * 60 * 1000;
const underMaxDuration = (v: { startAt: Date; endAt: Date }) =>
  v.endAt.getTime() - v.startAt.getTime() <= MAX_HOUR_LOG_DURATION_MS;
const underMaxDurationError = {
  message: "That span is over 16 hours — check the start/end (did the date slip?)",
  path: ["endAt"],
};

export const createHourLogSchema = z
  .object({ ...hourLogShape, ...createOnlyShape })
  .refine(endAfterStart, endAfterStartError)
  .refine(underMaxDuration, underMaxDurationError);

// ADMIN HOUR ENTRY — an admin records hours ON BEHALF OF a coach.
//
// 🔴 THE ONE FIELD THAT MAKES THIS A DIFFERENT SCHEMA IS `coachIds`, AND IT
// IS REQUIRED AND NON-EMPTY. On every other write path the subject is the
// session user, so there is nothing to supply and nothing to get wrong. Here
// the actor (the admin) and the subjects (the coaches) are different people,
// and each subject lands on a `hour_logs.coach_id` — the column every pay
// read groups by. Making it required rather than an optional override is what
// forces the server to answer "whose hours are these?" explicitly at the
// boundary.
//
// 📌 DELIBERATELY WITHOUT `createOnlyShape`. `source` and `acknowledgeHold`
// exist to drive the 1b-security-B held-then-approve gate, which does not run
// on this path (the gate routes a COACH's odd entry to an admin for a
// decision; when the admin IS the author there is nobody to route it to).
// Zod strips undeclared keys, so a caller sending either gets them dropped
// rather than honoured — which is the intent. Declaring them would instead
// put two fields on the contract that this path is documented to ignore.
export const adminLogHourForCoachSchema = z
  .object({
    ...hourLogShape,
    // 🔴 A LIST, BECAUSE A SHIFT IS ROUTINELY WORKED BY MORE THAN ONE PERSON.
    //
    // This was a single `coachId` when the feature shipped, and the first
    // real use on production was a block with TWO coaches on it — the admin
    // had to run the dialog twice, and between the two runs the schedule sat
    // in a half-recorded state that reads exactly like a mistake. Recording
    // one shift is ONE decision by the operator, so it should be one submit,
    // one set of warnings, and one confirmation.
    //
    // `.min(1)` rather than a nullable: "hours worked by nobody" is not a
    // state this form can express, and an empty array reaching the write loop
    // would silently succeed having recorded nothing at all.
    coachIds: z
      .array(z.string().min(1, "coachId is required"))
      .min(1, "Pick at least one coach"),
    // The admin has read the amber decision listing every warning this entry
    // raised — already paid through, overlapping log — and is going ahead.
    // Absent and false both mean "not confirmed". The server re-runs both
    // checks itself regardless, so this only ever unlocks a refusal the
    // server has independently decided is warranted; it is never evidence.
    confirmWarnings: z.boolean().optional(),
  })
  .refine(endAfterStart, endAfterStartError)
  .refine(underMaxDuration, underMaxDurationError);

export const editHourLogSchema = z
  .object(hourLogShape)
  .refine(endAfterStart, endAfterStartError)
  .refine(underMaxDuration, underMaxDurationError);

// Optional start/end correction supplied when an admin ACCEPTS a needs-review
// log (e.g. a coach logged a 30-min-off time; the admin shifts it and accepts
// in one step). Pay/hours recompute downstream from start/end × the snapshotted
// rate, so correcting the times also corrects the money — no rate/snapshot edit.
// Reuses the same endAt > startAt and ≤16h refines as the create/edit schemas.
export const acceptTimeEditSchema = z
  .object({
    startAt: z.coerce.date(),
    endAt: z.coerce.date(),
  })
  .refine(endAfterStart, endAfterStartError)
  .refine(underMaxDuration, underMaxDurationError);

export type CreateHourLogInput = z.infer<typeof createHourLogSchema>;
export type AdminLogHourForCoachInput = z.infer<
  typeof adminLogHourForCoachSchema
>;
export type EditHourLogInput = z.infer<typeof editHourLogSchema>;
export type AcceptTimeEditInput = z.infer<typeof acceptTimeEditSchema>;
